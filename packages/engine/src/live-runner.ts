import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Locator as PwLocator, Page } from 'playwright-core';
import { buildSelector, interpolate, type Assertion, type Keyword, type Locator, type Operator, type Step } from '@joule/core';

export type StepStatus = 'running' | 'pass' | 'fail' | 'skip';

export interface StepEvent {
  id: string;
  status: StepStatus;
  message?: string;
  ms?: number;
}

export interface LiveRunOptions {
  page: Page;
  steps: Step[];
  keywords: Keyword[];
  params: Record<string, string>;
  timeoutSeconds: number;
  projectDir: string;
  screenshotDir: string;
  signal: AbortSignal;
  onStep(e: StepEvent): void;
  /** Resolves when the user presses Continue. */
  onPause(stepId: string, message?: string): Promise<void>;
}

export class StepFailure extends Error {}

const ASSERT_RETRY_MS = 1000;

function compare(actual: string | number, op: Operator, expected: string): boolean {
  const a = String(actual);
  const num = (v: string | number) => Number(v);
  switch (op) {
    case '==':
      return a === expected;
    case '!=':
      return a !== expected;
    case 'contains':
      return a.includes(expected);
    case 'not contains':
      return !a.includes(expected);
    case 'starts':
      return a.startsWith(expected);
    case 'ends':
      return a.endsWith(expected);
    case 'matches':
      return new RegExp(expected).test(a);
    case '>':
      return num(actual) > num(expected);
    case '<':
      return num(actual) < num(expected);
    case '>=':
      return num(actual) >= num(expected);
    case '<=':
      return num(actual) <= num(expected);
  }
}

async function elementStates(loc: PwLocator): Promise<string[]> {
  const states: string[] = [];
  const count = await loc.count();
  if (count === 0) return ['detached'];
  states.push('attached');
  states.push((await loc.isVisible()) ? 'visible' : 'hidden');
  states.push((await loc.isEnabled()) ? 'enabled' : 'disabled');
  if (await loc.isEditable().catch(() => false)) states.push('editable');
  const checked = await loc.isChecked().catch(() => undefined);
  if (checked !== undefined) states.push(checked ? 'checked' : 'unchecked');
  return states;
}

/** Same semantics as the Browser library getters the generator emits. */
async function actualValue(page: Page, loc: PwLocator, a: Assertion, timeout: number): Promise<string | number | string[]> {
  switch (a.property) {
    case 'count':
      return loc.count();
    case 'state':
      return elementStates(loc);
    case 'text': {
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase(), undefined, { timeout });
      return ['input', 'textarea', 'select'].includes(tag) ? loc.inputValue({ timeout }) : loc.innerText({ timeout });
    }
    case 'value':
      return loc.evaluate((el) => String((el as HTMLInputElement).value ?? ''), undefined, { timeout });
    case 'attribute':
      return (await loc.getAttribute(a.name ?? '', { timeout })) ?? '';
  }
}

export async function checkAssertion(page: Page, selector: string, a: Assertion, expected: string, timeoutMs: number): Promise<{ ok: boolean; actual: string }> {
  const loc = page.locator(selector);
  const deadline = Date.now() + ASSERT_RETRY_MS;
  let last = { ok: false, actual: '' };
  for (;;) {
    try {
      const actual = await actualValue(page, loc, a, Math.min(timeoutMs, ASSERT_RETRY_MS));
      if (Array.isArray(actual)) {
        const negative = a.operator === '!=' || a.operator === 'not contains';
        last = { ok: actual.includes(expected) !== negative, actual: actual.join(', ') };
      } else {
        last = { ok: compare(actual, a.operator, expected), actual: String(actual) };
      }
    } catch (e) {
      last = { ok: false, actual: (e as Error).message.split('\n')[0] };
    }
    if (last.ok || Date.now() >= deadline) return last;
    await page.waitForTimeout(100);
  }
}

export class LiveRunner {
  private keywordsById: Map<string, Keyword>;
  private timeout: number;

  constructor(private o: LiveRunOptions) {
    this.keywordsById = new Map(o.keywords.map((k) => [k.id, k]));
    this.timeout = o.timeoutSeconds * 1000;
  }

  private v(text: string): string {
    return interpolate(text, this.o.params);
  }

  private sel(loc: Locator): string {
    return this.v(buildSelector(loc));
  }

  /** Runs all steps; returns false when a step failed (remaining steps are skipped). */
  async run(): Promise<boolean> {
    try {
      await this.steps(this.o.steps);
      return true;
    } catch (e) {
      if (e instanceof StepFailure) return false;
      throw e;
    }
  }

  private async steps(steps: Step[], depth = 0): Promise<void> {
    if (depth > 50) throw new StepFailure('Keyword recursion too deep');
    for (const step of steps) {
      if (this.o.signal.aborted) throw new StepFailure('Stopped');
      const started = Date.now();
      this.o.onStep({ id: step.id, status: 'running' });
      try {
        const skipped = await this.step(step, depth);
        this.o.onStep({ id: step.id, status: skipped === 'skip' ? 'skip' : 'pass', ms: Date.now() - started });
      } catch (e) {
        // An empty StepFailure means a nested step already reported the real error.
        const nested = e instanceof StepFailure && e.message === '';
        const message = nested ? 'A nested step failed' : e instanceof Error ? e.message.split('\n')[0] : String(e);
        this.o.onStep({ id: step.id, status: 'fail', message, ms: Date.now() - started });
        throw new StepFailure('');
      }
    }
  }

  private async step(step: Step, depth: number): Promise<void | 'skip'> {
    const page = this.o.page;
    const t = { timeout: this.timeout };
    switch (step.type) {
      case 'element': {
        const selector = this.sel(step.locator);
        const loc = page.locator(selector);
        if (step.mode === 'assert') {
          const a = step.assertion ?? { property: 'state', operator: '==', expected: 'visible' };
          const r = await checkAssertion(page, selector, a, this.v(a.expected), this.timeout);
          if (!r.ok) throw new StepFailure(`Expected ${a.property} ${a.operator} '${this.v(a.expected)}' but was '${r.actual}'`);
          return;
        }
        const value = this.v(step.action?.value ?? '');
        switch (step.action?.kind ?? 'click') {
          case 'click':
            return loc.click(t);
          case 'dblclick':
            return loc.dblclick(t);
          case 'rightclick':
            return loc.click({ ...t, button: 'right' });
          case 'fill':
            return loc.fill(value, t);
          case 'hover':
            return loc.hover(t);
          case 'select':
            await loc.selectOption({ label: value }, t);
            return;
          case 'check':
            return loc.check(t);
          case 'uncheck':
            return loc.uncheck(t);
          case 'press':
            return loc.press(value || 'Enter', t);
        }
        return;
      }
      case 'wait': {
        const w = step.wait;
        if (w.kind === 'time') return this.sleep(w.seconds * 1000);
        if (w.kind === 'load') return page.waitForLoadState(w.state, t);
        const loc = page.locator(this.sel(w.locator));
        const timeout = (w.timeoutSeconds ?? this.o.timeoutSeconds) * 1000;
        if (w.state === 'enabled') {
          const deadline = Date.now() + timeout;
          while (!(await loc.isEnabled().catch(() => false))) {
            if (Date.now() > deadline) throw new StepFailure(`Element not enabled after ${timeout / 1000}s`);
            await this.sleep(100);
          }
          return;
        }
        return loc.waitFor({ state: w.state, timeout });
      }
      case 'pause':
        return this.o.onPause(step.id, step.message);
      case 'screenshot': {
        const dir = isAbsolute(this.o.screenshotDir) ? this.o.screenshotDir : join(this.o.projectDir, this.o.screenshotDir);
        const path = join(dir, `${this.v(step.filename)}.png`);
        await mkdir(dirname(path), { recursive: true });
        await page.screenshot({ path, fullPage: step.fullPage });
        return;
      }
      case 'navigate':
        await page.goto(this.v(step.url), t);
        return;
      case 'keywordCall': {
        const kw = this.keywordsById.get(step.keywordId);
        if (!kw) throw new StepFailure('Keyword no longer exists');
        return this.steps(kw.steps, depth + 1);
      }
      case 'raw':
      case 'customCall':
        return 'skip'; // raw Robot lines and custom keywords only run via Robot Framework
      case 'group':
        return this.steps(step.steps, depth + 1);
      case 'if': {
        const a = step.condition.assertion;
        const r = await checkAssertion(page, this.sel(step.condition.locator), a, this.v(a.expected), this.timeout);
        return this.steps(r.ok ? step.then : step.else, depth + 1);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.o.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
