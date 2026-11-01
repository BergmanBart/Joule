import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { LIVE_PAGE_MARK, liveCustomSuite, type CustomCallStep } from '@joule/core';
import { parseOutputXml } from './robot-runner';

export interface CustomCallOptions {
  python: string;
  cdpUrl: string;
  page: Page;
  step: CustomCallStep;
  projectDir: string;
  params: Record<string, string>;
  timeoutSeconds: number;
  /** Absolute screenshot folder. */
  screenshotDir: string;
  signal: AbortSignal;
}

/**
 * Run one custom keyword call with Robot Framework on the in-app page: a one-test suite that attaches
 * to the browser over CDP, so the keyword runs exactly as written and the view shows what it does.
 */
export async function runCustomCall(o: CustomCallOptions): Promise<{ ok: boolean; message: string }> {
  const token = randomUUID();
  await o.page.evaluate(([key, value]) => ((window as any)[key] = value), [LIVE_PAGE_MARK, token]);
  const dir = await mkdtemp(join(tmpdir(), 'joule-custom-'));
  try {
    const suite = liveCustomSuite(o.step, {
      resource: join(o.projectDir, o.step.source),
      cdpUrl: o.cdpUrl,
      token,
      params: o.params,
      timeoutSeconds: o.timeoutSeconds,
      screenshotDir: o.screenshotDir,
    });
    await writeFile(join(dir, 'live.robot'), suite);
    const args = ['-m', 'robot', '--outputdir', dir, '--log', 'NONE', '--report', 'NONE', '--console', 'none', join(dir, 'live.robot')];
    const { code, output } = await new Promise<{ code: number; output: string }>((resolve) => {
      // Same working folder as run.bat, so ${EXECDIR} and relative paths match a real run.
      const child = spawn(o.python, args, { cwd: o.projectDir, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
      let output = '';
      const collect = (c: Buffer) => (output += c.toString('utf8'));
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const kill = () => child.kill();
      o.signal.addEventListener('abort', kill, { once: true });
      child.on('error', (e) => resolve({ code: -1, output: e.message }));
      child.on('close', (c) => {
        o.signal.removeEventListener('abort', kill);
        resolve({ code: c ?? -1, output });
      });
    });
    if (o.signal.aborted) return { ok: false, message: 'Stopped' };
    let result;
    try {
      result = parseOutputXml(await readFile(join(dir, 'output.xml'), 'utf8'))[0];
    } catch {
      /* Robot did not get as far as writing output.xml */
    }
    if (!result) {
      const last = output.trim().split(/\r?\n/).pop();
      return { ok: false, message: `Robot Framework could not run the keyword (exit code ${code})${last ? `: ${last}` : ''}` };
    }
    return { ok: result.status === 'PASS', message: result.message.replace(/^Parent suite setup failed:\s*/, '') };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
