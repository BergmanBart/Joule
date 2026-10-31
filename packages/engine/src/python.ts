import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BATTERIES_PKG,
  BROWSER_PKG,
  browserToInstall,
  compareVersions,
  dependsOn,
  lockedVersions,
  LOCK_FILE,
  PABOT_PKG,
  PINNED_PKGS,
  pinnedVersion,
  PYPROJECT_FILE,
  ROBOT_PKG,
  type BrowserName,
  type DepsInfo,
  type PlaywrightInfo,
} from '@joule/core';
import { ensurePyproject } from '@joule/core/node';

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

/** App setting overrides for the tools; looked up automatically when missing. */
export interface ToolPaths {
  python?: string;
  uv?: string;
}

/** Configured path / $JOULE_UV, then uv on PATH, then the folders uv's own installer uses. */
export async function findUv(configured?: string): Promise<{ path: string; version: string } | undefined> {
  const exe = IS_WIN ? 'uv.exe' : 'uv';
  const candidates = [configured, process.env.JOULE_UV, 'uv', join(homedir(), '.local', 'bin', exe), join(homedir(), '.cargo', 'bin', exe)];
  for (const c of candidates) {
    if (!c || (c !== 'uv' && !existsSync(c))) continue;
    const r = await exec(c, ['--version']);
    if (r.code === 0) return { path: c, version: r.stdout.trim().replace(/^uv\s+/, '').split(/\s/)[0] };
  }
  return undefined;
}

/** uv's official installer: a single binary in ~/.local/bin, no Python needed. */
const UV_INSTALLER: [string, string[]] = IS_WIN
  ? ['powershell', ['-ExecutionPolicy', 'ByPass', '-NoProfile', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex']]
  : ['sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']];

/** No colour codes in the output shown in the app. */
const UV_ENV = { NO_COLOR: '1' };

export interface DepsStatus {
  uv?: { path: string; version: string };
  python?: { path: string; version: string };
  robot?: string;
  browser?: string;
  batteries?: string;
  /** The node side of the Browser library is available (BrowserBatteries, or `rfbrowser init`). */
  browserInit: boolean;
  pabot?: string;
  playwright?: PlaywrightInfo;
  env: DepsInfo['env'];
  ok: boolean;
}

// The Browser library installs browsers in its own folder (or $PLAYWRIGHT_BROWSERS_PATH), named <name>-<revision>.
const PROBE = `
import json, os
import importlib.metadata as m
r = {}
try:
    from robot.version import VERSION; r["robot"] = VERSION
except Exception: pass
for key, dist in (("browser", "${BROWSER_PKG}"), ("batteries", "${BATTERIES_PKG}"), ("pabot", "${PABOT_PKG}")):
    try: r[key] = m.version(dist)
    except Exception: pass
pw = None
try:
    import Browser
    lib = os.path.join(os.path.dirname(Browser.__file__), "wrapper", "node_modules", "playwright-core")
    if os.path.isdir(lib): r["init"] = True; pw = lib
except Exception: pass
try:
    import BrowserBatteries
    r["init"] = True
    pw = os.path.join(os.path.dirname(BrowserBatteries.__file__), "bin", "wrapper", "node_modules", "playwright-core")
except Exception: pass
try:
    with open(os.path.join(pw, "package.json"), encoding="utf-8") as f: version = json.load(f)["version"]
    with open(os.path.join(pw, "browsers.json"), encoding="utf-8") as f: browsers = json.load(f)["browsers"]
    root = (os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "").strip()
    if not root or root == "0":
        try:
            from Browser.entry.constant import NODE_MODULES
            root = str(NODE_MODULES / "playwright-core" / ".local-browsers")
        except Exception:
            root = os.path.join(pw, ".local-browsers")
    r["playwright"] = {"version": version, "browsers": [
        {"name": b["name"], "version": b.get("browserVersion", ""),
         "installed": os.path.isdir(os.path.join(root, b["name"].replace("-", "_") + "-" + b["revision"]))}
        for b in browsers if b["name"] in ("chromium", "firefox")]}
except Exception: pass
print(json.dumps(r))
`;

async function readText(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined);
}

export async function checkDeps(projectDir: string, paths: ToolPaths = {}): Promise<DepsStatus> {
  const [python, uv] = await Promise.all([findPython(projectDir, paths.python), findUv(paths.uv)]);
  const pyproject = await readText(join(projectDir, PYPROJECT_FILE));
  const lock = await readText(join(projectDir, LOCK_FILE));
  const pins = Object.fromEntries(PINNED_PKGS.map((p) => [p, pyproject && pinnedVersion(pyproject, p)]).filter(([, v]) => v));
  const locked = lock ? lockedVersions(lock) : {};
  const env: DepsInfo['env'] = {
    pyproject: pyproject !== undefined,
    lock: lock !== undefined,
    pins,
    locked: Object.fromEntries([...PINNED_PKGS, PABOT_PKG].filter((p) => locked[p]).map((p) => [p, locked[p]])),
  };
  // Exit code 0: uv.lock matches pyproject.toml and .venv has exactly the locked packages.
  if (uv && pyproject !== undefined && lock !== undefined) env.synced = (await exec(uv.path, ['sync', '--check'], { cwd: projectDir, env: UV_ENV })).code === 0;
  if (!python) return { uv, browserInit: false, env, ok: false };
  const version = (await exec(python, ['--version'])).stdout.trim().replace(/^Python /, '');
  const probe = await exec(python, ['-c', PROBE]);
  let r: { robot?: string; browser?: string; batteries?: string; init?: boolean; pabot?: string; playwright?: PlaywrightInfo } = {};
  try {
    r = JSON.parse(probe.stdout.trim().split('\n').pop() ?? '{}');
  } catch {
    /* keep empty */
  }
  return {
    uv,
    python: { path: python, version },
    robot: r.robot,
    browser: r.browser,
    batteries: r.batteries,
    browserInit: !!r.init,
    pabot: r.pabot,
    playwright: r.playwright,
    env,
    ok: !!(r.robot && r.browser && r.init),
  };
}

/** What installDeps does, for people who would rather run it themselves (or in a pipeline: setup.bat / setup.sh). */
export function installCommands(projectDir: string, browser: BrowserName, uvFound: boolean): string[] {
  const download = browserToInstall(browser);
  return [
    ...(uvFound ? [] : [[UV_INSTALLER[0], ...UV_INSTALLER[1].map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ')]),
    `cd "${projectDir}"`,
    'uv sync',
    ...(download ? [`"${venvPython(projectDir)}" -m Browser.entry install ${download}`] : []),
  ];
}

export interface InstallOptions {
  projectName: string;
  browser: BrowserName;
  /** Exact versions to pin in pyproject.toml first; the Browser library version also goes to its batteries. */
  pins?: { robot?: string; browser?: string };
  /** Move the pinned packages to their newest release, and everything else in uv.lock too. */
  upgrade?: boolean;
  uv?: string;
}

/**
 * Bring <project>/.venv in line with pyproject.toml and uv.lock: installs uv when missing, writes the default
 * pyproject.toml, locks, syncs and downloads the browser build the locked Browser library drives.
 * The first lock pins Robot Framework and the Browser library to exact versions in pyproject.toml, so the choice is
 * visible and stays put; the Browser library and its batteries are always pinned to the same version.
 */
export async function installDeps(projectDir: string, o: InstallOptions, onLine: (l: string) => void): Promise<boolean> {
  const run = async (cmd: string, args: string[]) => {
    onLine(`$ ${cmd} ${args.join(' ')}`);
    const r = await exec(cmd, args, { cwd: projectDir, onLine, env: UV_ENV });
    if (r.code !== 0) onLine(`Command failed with exit code ${r.code}`);
    return r.code === 0;
  };
  let uv = (await findUv(o.uv))?.path;
  if (!uv) {
    if (!(await run(...UV_INSTALLER))) return false;
    uv = (await findUv(o.uv))?.path;
    if (!uv) {
      onLine('uv was installed but cannot be found. Set its path in App settings, or restart Joule.');
      return false;
    }
  }
  await ensurePyproject(projectDir, o.projectName);
  const pyprojectPath = join(projectDir, PYPROJECT_FILE);
  const lockPath = join(projectDir, LOCK_FILE);
  const fresh = !existsSync(lockPath);
  const add = (specs: string[]) => run(uv, ['add', '--no-sync', ...specs]);

  if (o.pins?.robot && !(await add([`${ROBOT_PKG}==${o.pins.robot}`]))) return false;
  if (o.pins?.browser && !(await add([`${BROWSER_PKG}==${o.pins.browser}`, `${BATTERIES_PKG}==${o.pins.browser}`]))) return false;
  if (o.upgrade) {
    // `uv add` keeps a requirement that is already there, so take the pinned packages out and add them back at their newest
    const present = PINNED_PKGS.filter((p) => dependsOn(readFileSync(pyprojectPath, 'utf8'), p));
    if (present.length && !(await run(uv, ['remove', '--no-sync', ...present]))) return false;
    if (!(await run(uv, ['add', '--no-sync', '--bounds', 'exact', ...PINNED_PKGS]))) return false;
    if (!(await run(uv, ['lock', '--upgrade']))) return false;
  } else if (!(await run(uv, ['lock']))) return false;

  // The batteries can lag a release behind the Browser library; both have the older version.
  const locked = lockedVersions(await readFile(lockPath, 'utf8'));
  const pyproject = await readFile(pyprojectPath, 'utf8');
  const [lib, batteries] = [locked[BROWSER_PKG], locked[BATTERIES_PKG]];
  const pins: string[] = [];
  if (lib && batteries && lib !== batteries) {
    const v = compareVersions(lib, batteries) < 0 ? lib : batteries;
    onLine(`Browser library ${lib} and batteries ${batteries} differ: pinning both to ${v}`);
    pins.push(`${BROWSER_PKG}==${v}`, `${BATTERIES_PKG}==${v}`);
  } else if (fresh) {
    for (const p of PINNED_PKGS) if (locked[p] && !pinnedVersion(pyproject, p)) pins.push(`${p}==${locked[p]}`);
  }
  if (pins.length && !(await add(pins))) return false;

  if (!(await run(uv, ['sync']))) return false;
  const download = browserToInstall(o.browser);
  return !download || run(venvPython(projectDir), ['-m', 'Browser.entry', 'install', download]);
}

/** Released (non pre-release, not yanked) versions on PyPI, newest first; empty when PyPI cannot be reached. */
async function releases(pkg: string): Promise<string[]> {
  try {
    const res = await fetch(`https://pypi.org/pypi/${pkg}/json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const { releases } = (await res.json()) as { releases: Record<string, { yanked?: boolean }[]> };
    return Object.entries(releases)
      .filter(([v, files]) => /^\d+(\.\d+)*$/.test(v) && files.some((f) => !f.yanked))
      .map(([v]) => v)
      .sort((a, b) => compareVersions(b, a));
  } catch {
    return [];
  }
}

/** Version suggestions: Robot Framework, and Browser library versions that also have batteries. */
export async function releasedVersions(): Promise<{ robot: string[]; browser: string[] }> {
  const [robot, lib, batteries] = await Promise.all([releases(ROBOT_PKG), releases(BROWSER_PKG), releases(BATTERIES_PKG)]);
  const withBatteries = new Set(batteries);
  return { robot, browser: lib.filter((v) => withBatteries.has(v)) };
}
