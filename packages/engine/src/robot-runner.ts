import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { effectiveRunPlan, testFileName, type Environment, type Project } from '@uitester/core';

export interface TestResult {
  testId?: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'NOT RUN';
  message: string;
}

export interface RobotRunResult {
  ok: boolean;
  logDir: string;
  results: TestResult[];
  exitCode: number;
}

export interface RobotRunOptions {
  projectDir: string;
  project: Project;
  python: string;
  /** Tests to run; all tests (following the run plan) when omitted. */
  testIds?: string[];
  env: Environment;
  headless: boolean;
  /** Use pabot for stages with more than one test (only when running the whole plan). */
  parallel: boolean;
  onLine(line: string): void;
  onPause(message: string): void;
}

export function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const unxml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&');

/** Per-test status from output.xml (last <status> directly inside each <test>). */
export function parseOutputXml(xml: string): TestResult[] {
  const results: TestResult[] = [];
  const re = /<test\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/test>/g;
  for (const m of xml.matchAll(re)) {
    const body = m[2];
    const statuses = [...body.matchAll(/<status\s+status="([A-Z ]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/status>)/g)];
    const last = statuses[statuses.length - 1];
    const doc = /<doc>UITester test ([^<]+)<\/doc>/.exec(body);
    results.push({
      testId: doc?.[1].trim(),
      name: unxml(m[1]),
      status: (last?.[1] as TestResult['status']) ?? 'NOT RUN',
      message: unxml(last?.[2] ?? ''),
    });
  }
  return results;
}

export class RobotRun {
  private child?: ChildProcess;
  private stopped = false;

  constructor(private o: RobotRunOptions) {}

  /** Answer a Pause For Key prompt (the generated library reads a line from stdin). */
  continue(): void {
    this.child?.stdin?.write('\n');
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
  }

  private spawn(args: string[]): Promise<number> {
    const { o } = this;
    o.onLine(`$ ${o.python} ${args.join(' ')}`);
    return new Promise((resolve) => {
      // pabot starts `robot` itself, so the interpreter's (venv) folder must be on PATH.
      const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
      const binDir = isAbsolute(o.python) ? dirname(o.python) : undefined;
      const child = spawn(o.python, args, {
        cwd: o.projectDir,
        env: {
          ...process.env,
          ...(binDir ? { [pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ''}` } : {}),
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          UITESTER_PAUSE: 'stdin',
        },
        windowsHide: true,
      });
      this.child = child;
      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('[UITESTER-PAUSE]')) o.onPause(line.slice(16).trim());
          else o.onLine(line);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => {
        o.onLine(e.message);
        resolve(-1);
      });
      child.on('close', (code) => {
        if (buffer) o.onLine(buffer);
        this.child = undefined;
        resolve(code ?? -1);
      });
    });
  }

  async run(): Promise<RobotRunResult> {
    const { o } = this;
    const logDir = join('logs', timestamp());
    const vars = ['-v', `ENV:${o.env}`, ...(o.headless ? ['-v', 'HEADLESS:True'] : [])];
    const common = [...vars, '--outputdir', logDir, '--consolecolors', 'off', '--consolemarkers', 'off', '--consolewidth', '100'];
    const tests = o.testIds ? o.project.tests.filter((t) => o.testIds!.includes(t.id)) : o.project.tests;
    const files = tests.map((t) => testFileName(o.project, t));

    const stages = effectiveRunPlan(o.project);
    const usePabot = !o.testIds && o.parallel && stages.some((s) => s.length > 1);
    let code: number;
    if (usePabot) {
      const processes = Math.max(...stages.map((s) => s.length));
      code = await this.spawn([
        '-m', 'pabot.pabot', '--command', o.python, '-m', 'robot', '--end-command',
        '--processes', String(processes), '--ordering', 'run_plan.txt', ...common, 'tests',
      ]);
    } else {
      code = await this.spawn(['-m', 'robot', ...common, ...(files.length === o.project.tests.length ? ['tests'] : files)]);
    }

    for (let i = 1; i <= o.project.settings.retries && code !== 0 && !this.stopped; i++) {
      const output = join(logDir, 'output.xml');
      if (!existsSync(join(o.projectDir, output))) break;
      o.onLine(`Retry ${i}/${o.project.settings.retries} for failed tests`);
      const rerun = `rerun${i}.xml`;
      code = await this.spawn(['-m', 'robot', ...common, '--rerunfailed', output, '--output', rerun, '--log', 'NONE', '--report', 'NONE', ...files]);
      await this.spawn(['-m', 'robot.rebot', '--merge', '--outputdir', logDir, '--output', 'output.xml', output, join(logDir, rerun)]);
    }

    let results: TestResult[] = [];
    try {
      results = parseOutputXml(await readFile(join(o.projectDir, logDir, 'output.xml'), 'utf8'));
    } catch {
      o.onLine('No output.xml was produced.');
    }
    const ok = code === 0 && results.length > 0 && results.every((r) => r.status !== 'FAIL');
    return { ok, logDir, results, exitCode: code };
  }
}
