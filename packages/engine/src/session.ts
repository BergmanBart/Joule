import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { chromium, firefox, type Browser, type BrowserContext, type CDPSession, type ElementHandle, type Page } from 'playwright-core';
import type { BrowserName, ElementDescriptor } from '@uitester/core';

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

/** Launch a browser for the given setting; falls back to installed Edge / Chrome when bundled browsers are missing. */
export async function launchBrowser(name: BrowserName, headless: boolean): Promise<Browser> {
  if (name === 'firefox') return firefox.launch({ headless });
  const channels = name === 'msedge' ? ['msedge', 'chrome', undefined] : [undefined, 'chrome', 'msedge'];
  let lastError: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launch({ headless, channel });
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
  private mode: ViewMode = 'interact';
  private items: HighlightItem[] = [];
  private refreshQueued = false;
  private refreshing = false;
  options?: SessionOptions;

  get isOpen(): boolean {
    return !!this.page && !this.page.isClosed();
  }

  async start(options: SessionOptions, url?: string): Promise<void> {
    await this.stop();
    this.options = options;
    this.browser = await launchBrowser(options.browser, true);
    this.context = await this.browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1 });
    await this.context.exposeBinding('__uitesterPick', (_src, d: ElementDescriptor) => {
      this.emit('pick', d);
    });
    await this.context.exposeBinding('__uitesterChanged', () => this.refresh());
    await this.context.exposeBinding('__uitesterHello', () => ({ mode: this.mode }));
    await this.context.addInitScript(OVERLAY);
    this.context.on('page', (p) => void this.attach(p));
    await this.attach(await this.context.newPage());
    if (url) await this.navigate(url);
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
    await this.startStream(page);
    if (previous && previous !== page) this.emit('url', page.url());
  }

  private async startStream(page: Page): Promise<void> {
    await this.stopStream();
    if (this.options?.browser === 'firefox') {
      // No CDP screencast in Firefox: poll screenshots.
      const tick = async () => {
        if (page.isClosed() || this.page !== page) return;
        try {
          const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
          this.emit('frame', { data: buf.toString('base64'), width: this.options!.width, height: this.options!.height });
        } catch {
          /* page navigating */
        }
        this.pollTimer = setTimeout(tick, 150);
      };
      void tick();
      return;
    }
    const cdp = await page.context().newCDPSession(page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      this.emit('frame', { data: f.data, width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
  }

  private async stopStream(): Promise<void> {
    clearTimeout(this.pollTimer);
    const cdp = this.cdp;
    this.cdp = undefined;
    if (cdp) await cdp.detach().catch(() => {});
  }

  async stop(): Promise<void> {
    await this.stopStream();
    const browser = this.browser;
    this.browser = this.context = this.page = undefined;
    if (browser) await browser.close().catch(() => {});
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) return;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e: Error) => {
      // Show the error page instead of throwing (bad URL, site down, ...)
      return this.page?.setContent(`<pre style="font:14px monospace;padding:24px;color:#b00">${escapeHtml(e.message)}</pre>`);
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
    await this.page?.evaluate((m) => (window as any).__uitester?.setMode(m), mode).catch(() => {});
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

  async setHighlights(items: HighlightItem[]): Promise<void> {
    this.items = items;
    await this.refresh();
  }

  /** Resolve every highlight selector to element handles and hand them to the overlay. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    const page = this.page;
    if (!page || page.isClosed()) return;
    this.refreshing = true;
    const handles: ElementHandle[] = [];
    try {
      const resolved = [];
      for (const item of this.items) {
        let els: ElementHandle[] = [];
        try {
          const loc = page.locator(item.selector);
          els = item.all ? (await loc.elementHandles()).slice(0, 25) : (await loc.elementHandles()).slice(0, 1);
        } catch {
          /* invalid selector */
        }
        handles.push(...els);
        resolved.push({ n: item.n, kind: item.kind, els });
      }
      await page.evaluate((items) => (window as any).__uitester?.setItems(items), resolved);
    } catch {
      /* navigation in progress; the load event will refresh again */
    } finally {
      await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
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
