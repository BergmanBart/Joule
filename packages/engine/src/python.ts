import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const IS_WIN = process.platform === 'win32';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function exec(cmd: string, args: string[], opts: { cwd?: string; onLine?: (line: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...opts.env }, windowsHide: true });
    const lines = (chunk: Buffer, sink: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      if (sink === 'out') stdout += text;
      else stderr += text;
      if (opts.onLine) for (const l of text.split(/\r?\n/)) if (l.trim()) opts.onLine(l);
    };
    child.stdout.on('data', (c: Buffer) => lines(c, 'out'));
    child.stderr.on('data', (c: Buffer) => lines(c, 'err'));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + e.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function venvPython(dir: string): string {
  return IS_WIN ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python');
}

/** Configured path / $JOULE_PYTHON, then a .venv in the project folder or any parent, then the system Python. */
export async function findPython(projectDir: string, configured?: string): Promise<string | undefined> {
  for (const c of [configured, process.env.JOULE_PYTHON]) if (c && existsSync(c)) return c;
  for (let dir = projectDir; ; dir = dirname(dir)) {
    const candidate = venvPython(dir);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  for (const cmd of IS_WIN ? ['python', 'py'] : ['python3', 'python']) {
    const r = await exec(cmd, ['--version']);
    if (r.code === 0 && /Python 3/.test(r.stdout + r.stderr)) return cmd;
  }
  return undefined;
}

export interface DepsStatus {
  python?: { path: string; version: string };
  robot?: string;
  browser?: string;
  /** The node side of the Browser library is available (BrowserBatteries, or `rfbrowser init`). */
  browserInit: boolean;
  pabot?: string;
  ok: boolean;
}

const PROBE = `
import json, os
r = {}
try:
    from robot.version import VERSION; r["robot"] = VERSION
except Exception: pass
try:
    import Browser, importlib.metadata as m
    r["browser"] = m.version("robotframework-browser")
    r["init"] = os.path.isdir(os.path.join(os.path.dirname(Browser.__file__), "wrapper", "node_modules", "playwright-core"))
except Exception: pass
try:
    import BrowserBatteries; r["init"] = True
except Exception: pass
try:
    import importlib.metadata as m; r["pabot"] = m.version("robotframework-pabot")
except Exception: pass
print(json.dumps(r))
`;

export async function checkDeps(projectDir: string, configured?: string): Promise<DepsStatus> {
  const python = await findPython(projectDir, configured);
  if (!python) return { browserInit: false, ok: false };
  const version = (await exec(python, ['--version'])).stdout.trim().replace(/^Python /, '');
  const probe = await exec(python, ['-c', PROBE]);
  let r: { robot?: string; browser?: string; init?: boolean; pabot?: string } = {};
  try {
    r = JSON.parse(probe.stdout.trim().split('\n').pop() ?? '{}');
  } catch {
    /* keep empty */
  }
  return {
    python: { path: python, version },
    robot: r.robot,
    browser: r.browser,
    browserInit: !!r.init,
    pabot: r.pabot,
    ok: !!(r.robot && r.browser && r.init),
  };
}

// BrowserBatteries ships the Browser library's node side prebuilt, so no Node.js/npm is needed.
const PACKAGES = ['robotframework', 'robotframework-browser', 'robotframework-browser-batteries', 'robotframework-pabot'];

export function installCommands(projectDir: string, skipBrowsers: boolean): string[] {
  const py = venvPython(projectDir);
  return [
    `python -m venv "${join(projectDir, '.venv')}"`,
    `"${py}" -m pip install --upgrade ${PACKAGES.join(' ')}`,
    ...(skipBrowsers ? [] : [`"${py}" -m Browser.entry install`]),
  ];
}

/** Create <project>/.venv and install Robot Framework, Browser library (with batteries) and pabot; Playwright browsers unless skipped. */
export async function installDeps(projectDir: string, skipBrowsers: boolean, onLine: (l: string) => void): Promise<boolean> {
  const system = IS_WIN ? 'python' : 'python3';
  const py = venvPython(projectDir);
  const steps: [string, string[]][] = [
    [system, ['-m', 'venv', join(projectDir, '.venv')]],
    [py, ['-m', 'pip', 'install', '--upgrade', ...PACKAGES]],
    ...(skipBrowsers ? [] : [[py, ['-m', 'Browser.entry', 'install']] as [string, string[]]]),
  ];
  for (const [cmd, args] of steps) {
    if (cmd === system && existsSync(py)) continue;
    onLine(`$ ${cmd} ${args.join(' ')}`);
    const r = await exec(cmd, args, { cwd: projectDir, onLine });
    if (r.code !== 0) {
      onLine(`Command failed with exit code ${r.code}`);
      return false;
    }
  }
  return true;
}
