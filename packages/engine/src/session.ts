import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { chromium, firefox, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import type { BrowserName, ElementDescriptor } from '@joule/core';

const OVERLAY = readFileSync(new URL('./overlay.js', import.meta.url), 'utf8');

export type ViewMode = 'record' | 'interact' | 'run';

export interface HighlightItem {
  n: number;
  selector: string;
  kind: 'normal' | 'selected' | 'dim' | 'running';
  /** Outline every match (used for the selected step to visualize duplicates). */
  all?: boolean;
}

export interface SessionOptions {
  browser: BrowserName;
  width: number;
  height: number;
}

export interface MouseInput {
  type: 'move' | 'down' | 'up' | 'wheel';
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
}

export interface KeyInput {
  type: 'down' | 'up' | 'text';
  key?: string;
  text?: string;
}

export interface SessionEvents {
  frame: [{ data: string; width: number; height: number }];
  pick: [ElementDescriptor];
  url: [string];
  closed: [];
}

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Launch a browser for the given setting; falls back to installed Edge / Chrome when bundled browsers are missing.
 * `debugPort` opens the Chrome DevTools Protocol on 127.0.0.1 (ignored for Firefox).
 */
export async function launchBrowser(name: BrowserName, headless: boolean, debugPort?: number): Promise<Browser> {
  if (name === 'firefox') return firefox.launch({ headless });
  const channels = name === 'msedge' ? ['msedge', 'chrome', undefined] : [undefined, 'chrome', 'msedge'];
  const args = debugPort ? [`--remote-debugging-port=${debugPort}`] : undefined;
  let lastError: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless, channel, args });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * The live browser shown in the middle of the UI: a headless page streamed as JPEG frames,
 * with mouse/keyboard forwarded from the canvas and an overlay injected for outlines and picking.
 */
export class BrowserSession extends EventEmitter<SessionEvents> {
  private browser?: Browser;
  private context?: BrowserContext;
  page?: Page;
  private cdp?: CDPSession;
  private pollTimer?: NodeJS.Timeout;
  /** Bumped by every stop of the frame stream, so a start that was overtaken leaves nothing running. */
  private streamGen = 0;
  /** False while nobody shows the view: the browser then sends no frames at all. */
  private streaming = true;
  /** Size the view is shown at: frames are scaled down to fit, which is less to encode, send and decode. */
  private frameSize?: { width: number; height: number };
  private mode: ViewMode = 'interact';
  private items: HighlightItem[] = [];
  private refreshQueued = false;
  private refreshing = false;
  options?: SessionOptions;
  /** CDP endpoint Robot Framework attaches to for custom keywords; unset for Firefox. */
  cdpUrl?: string;

  get isOpen(): boolean {
    return !!this.page && !this.page.isClosed();
  }

  async start(options: SessionOptions, url?: string): Promise<void> {
    await this.stop();
    this.options = options;
    const port = options.browser === 'firefox' ? undefined : await freePort();
    this.browser = await launchBrowser(options.browser, true, port);
    this.cdpUrl = port ? `http://127.0.0.1:${port}` : undefined;
    await this.openContext();
    if (url) await this.navigate(url);
  }

  /** Swap in a fresh context, like the clean browser a real test run gets: cookies, storage and cache are gone. */
  async reset(url?: string): Promise<void> {
    if (!this.browser) return;
    const old = this.context;
    await this.openContext();
    await old?.close().catch(() => {});
    if (url) await this.navigate(url);
  }

  private async openContext(): Promise<void> {
    const { width, height } = this.options!;
    const context = await this.browser!.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    await context.exposeBinding('__joulePick', (_src, d: ElementDescriptor) => {
      this.emit('pick', d);
    });
    await context.exposeBinding('__jouleChanged', () => this.refresh());
    await context.exposeBinding('__jouleHello', () => ({ mode: this.mode }));
    await context.addInitScript(OVERLAY);
    context.on('page', (p) => void this.attach(p));
    this.context = context;
    await this.attach(await context.newPage());
  }

  private async attach(page: Page): Promise<void> {
    const previous = this.page;
    this.page = page;
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) this.emit('url', f.url());
    });
    page.on('load', () => this.refresh());
    page.on('close', () => {
      if (this.page !== page) return;
      const others = this.context?.pages().filter((p) => !p.isClosed()) ?? [];
      if (others.length) void this.attach(others[others.length - 1]);
      else this.emit('closed');
    });
    if (this.streaming) await this.startStream(page);
    if (previous && previous !== page) this.emit('url', page.url());
  }

  /** Pause the frame stream while nobody shows the view; resuming streams the current page again. */
  async setStreaming(on: boolean): Promise<void> {
    if (on === this.streaming) return;
    this.streaming = on;
    const page = this.page;
    if (!on) await this.stopStream();
    else if (page && !page.isClosed()) await this.startStream(page);
  }

  async setFrameSize(size: { width: number; height: number } | undefined): Promise<void> {
    if (size?.width === this.frameSize?.width && size?.height === this.frameSize?.height) return;
    this.frameSize = size;
    const page = this.page;
    if (this.streaming && page && !page.isClosed()) await this.startStream(page);
  }

  private async startStream(page: Page): Promise<void> {
    const gen = await this.stopStream();
    if (this.options?.browser === 'firefox') {
      // No CDP screencast in Firefox: poll screenshots and pass on the ones that changed.
      let last = '';
      const tick = async () => {
        if (gen !== this.streamGen || page.isClosed() || this.page !== page) return;
        try {
          const data = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
          if (data !== last && gen === this.streamGen) this.emit('frame', { data, width: this.options!.width, height: this.options!.height });
          last = data;
        } catch {
          /* page navigating */
        }
        if (gen === this.streamGen) this.pollTimer = setTimeout(tick, 150);
      };
      void tick();
      return;
    }
    const cdp = await page.context().newCDPSession(page);
    if (gen !== this.streamGen) {
      await cdp.detach().catch(() => {}); // stopped or restarted meanwhile
      return;
    }
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      this.emit('frame', { data: f.data, width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    const max = this.frameSize;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1, maxWidth: max?.width, maxHeight: max?.height }).catch((e) => {
      if (gen === this.streamGen && !page.isClosed()) throw e; // a popup may close before its stream starts
    });
  }

  /** Returns the generation a stream started after this stop must still match when it gets going. */
  private async stopStream(): Promise<number> {
    const gen = ++this.streamGen;
    clearTimeout(this.pollTimer);
    const cdp = this.cdp;
    this.cdp = undefined;
    if (cdp) await cdp.detach().catch(() => {});
    return gen;
  }

  async stop(): Promise<void> {
    await this.stopStream();
    const browser = this.browser;
    this.browser = this.context = this.page = this.cdpUrl = undefined;
    if (browser) await browser.close().catch(() => {});
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) return;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(async (e: Error) => {
      // Show the error page instead of throwing (bad URL, site down, ...). The browser may still be committing
      // its own error page, which destroys content set too early, so retry briefly.
      const html = `<pre style="font:14px monospace;padding:24px;color:#b00">${escapeHtml(e.message)}</pre>`;
      for (let i = 0; i < 5; i++) {
        try {
          return await this.page?.setContent(html);
        } catch {
          await this.page?.waitForTimeout(200).catch(() => {});
        }
      }
    });
  }

  async reload(): Promise<void> {
    await this.page?.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  async back(): Promise<void> {
    await this.page?.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  async setMode(mode: ViewMode): Promise<void> {
    this.mode = mode;
    await this.page?.evaluate((m) => (window as any).__joule?.setMode(m), mode).catch(() => {});
  }

  getMode(): ViewMode {
    return this.mode;
  }

  async mouse(input: MouseInput): Promise<void> {
    const m = this.page?.mouse;
    if (!m) return;
    if (input.type === 'move') await m.move(input.x, input.y);
    else if (input.type === 'down') {
      await m.move(input.x, input.y);
      await m.down({ button: input.button, clickCount: input.clickCount });
    } else if (input.type === 'up') {
      await m.move(input.x, input.y);
      await m.up({ button: input.button, clickCount: input.clickCount });
    } else await m.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
  }

  async key(input: KeyInput): Promise<void> {
    const k = this.page?.keyboard;
    if (!k) return;
    try {
      if (input.type === 'text' && input.text) await k.insertText(input.text);
      else if (input.type === 'down' && input.key) await k.down(input.key);
      else if (input.type === 'up' && input.key) await k.up(input.key);
    } catch {
      /* unknown key name */
    }
  }

  /** Count matches for a selector on the current page (for the search-details warning). */
  async count(selector: string): Promise<number | { error: string }> {
    if (!this.page) return 0;
    try {
      return await this.page.locator(selector).count();
    } catch (e) {
      return { error: (e as Error).message.split('\n')[0] };
    }
  }

  /** Limit record-mode picks to ancestors / descendants of the matches of `selector`; null lifts the limit. */
  async setPickConstraint(c: { selector: string; relation: 'ancestor' | 'descendant' } | null): Promise<{ found: boolean }> {
    const page = this.page;
    if (!page) return { found: false };
    try {
      if (!c) {
        await page.evaluate(() => (window as any).__joule?.setConstraint(null));
        return { found: true };
      }
      const found = await page.locator(c.selector).evaluateAll((els, relation) => {
        (window as any).__joule?.setConstraint(els.slice(0, 50), relation);
        return els.length;
      }, c.relation);
      return { found: found > 0 };
    } catch {
      return { found: false };
    }
  }

  /** Describe the parent element (or shadow host) of the first match of `selector` (to widen a scope by one level). */
  async describeParent(selector: string): Promise<ElementDescriptor | undefined> {
    if (!this.page) return undefined;
    try {
      return await this.page
        .locator(selector)
        .first()
        .evaluate((el) => (window as any).__joule?.describeParent(el), undefined, { timeout: 1000 });
    } catch {
      return undefined;
    }
  }

  async setHighlights(items: HighlightItem[]): Promise<void> {
    this.items = items;
    await this.refresh();
  }

  /**
   * Resolve every highlight selector and hand the matches to the overlay: one call per selector that passes its
   * elements on inside the page (element handles would cost a round trip each, and leak for broad selectors).
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    const page = this.page;
    if (!page || page.isClosed()) return;
    this.refreshing = true;
    try {
      const items = this.items;
      await Promise.all(
        items.map((item, i) =>
          page
            .locator(item.selector)
            .evaluateAll((els, a) => (window as any).__joule?.stageItem(a.i, { n: a.n, kind: a.kind, els: els.slice(0, a.max) }), {
              i,
              n: item.n,
              kind: item.kind,
              max: item.all ? 25 : 1,
            })
            .catch(() => {}), // invalid selector: no outline
        ),
      );
      await page.evaluate((count) => (window as any).__joule?.commitItems(count), items.length);
    } catch {
      /* navigation in progress; the load event will refresh again */
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}
