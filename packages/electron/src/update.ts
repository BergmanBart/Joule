/**
 * Updates from GitHub releases. The portable zip can't use electron-updater (that only updates installers), so:
 * check the latest release, download its zip into data/update/, unpack it, and let a small PowerShell script copy
 * it over the app folder once Joule has exited (Windows locks a running exe), then start Joule again.
 * Nothing is installed unless the user asks for it.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { app, net } from 'electron';

const REPO = 'BergmanBart/Joule';
const ASSET = /-win-x64\.zip$/;

/** Sent to the UI (see packages/ui/src/desktop.ts). */
export interface UpdateState {
  version: string;
  notesUrl: string;
  /** False when the app folder is read-only (network share, locked USB stick): the UI links to the release instead. */
  canInstall: boolean;
  status: 'available' | 'downloading' | 'installing' | 'error';
  progress?: number;
  error?: string;
}

interface Release {
  tag_name: string;
  html_url: string;
  assets: { name: string; browser_download_url: string; size: number; digest?: string | null }[];
}

const appDir = dirname(process.execPath);
const updateDir = join(appDir, 'data', 'update');

let state: UpdateState | undefined;
let asset: Release['assets'][number] | undefined;
let notify: (s: UpdateState | undefined) => void = () => {};

function set(next: UpdateState | undefined) {
  state = next;
  notify(state);
}

export const getUpdate = () => state;

function parseVersion(v: string) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? m.slice(1).map(Number) : undefined;
}

export function isNewer(candidate: string, current: string) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] > b[i];
}

function writable(dir: string) {
  const probe = join(dir, `.joule-write-test-${process.pid}`);
  try {
    writeFileSync(probe, '');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function check() {
  if (state && state.status !== 'available') return;
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Joule/${app.getVersion()}` },
    });
    if (!res.ok) return;
    const release = (await res.json()) as Release;
    const version = release.tag_name.replace(/^v/, '');
    if (!isNewer(version, app.getVersion())) return;
    asset = release.assets.find((a) => ASSET.test(a.name));
    set({ version, notesUrl: release.html_url, canInstall: !!asset && writable(appDir), status: 'available' });
  } catch {
    /* offline: try again later */
  }
}

/** Checks shortly after startup and then every few hours; `onChange` gets each new state. */
export function startUpdateChecks(onChange: (s: UpdateState | undefined) => void) {
  notify = onChange;
  // Leftovers of an earlier update (or a failed one).
  rmSync(updateDir, { recursive: true, force: true });
  setTimeout(check, 5_000);
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

async function download(url: string, file: string, size: number) {
  const res = await net.fetch(url, { headers: { 'User-Agent': `Joule/${app.getVersion()}` } });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || size;
  const hash = createHash('sha256');
  const out = createWriteStream(file);
  let received = 0;
  let shown = -1;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      received += chunk.length;
      const pct = Math.floor((received / total) * 100);
      if (pct !== shown && state) set({ ...state, progress: (shown = pct) });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return hash.digest('hex');
}

/** The folder holding Joule.exe in the unpacked zip (its root, or a single top folder). */
function findAppRoot(dir: string, exe: string): string | undefined {
  if (existsSync(join(dir, exe))) return dir;
  const subdirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  return subdirs.length === 1 ? findAppRoot(join(dir, subdirs[0].name), exe) : undefined;
}

const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Downloads and unpacks the update, starts the script that swaps it in, and quits. */
export async function installUpdate() {
  if (!state?.canInstall || !asset || state.status === 'downloading' || state.status === 'installing') return;
  set({ ...state, status: 'downloading', progress: 0, error: undefined });
  try {
    rmSync(updateDir, { recursive: true, force: true });
    mkdirSync(updateDir, { recursive: true });
    const zip = join(updateDir, asset.name);
    const sha256 = await download(asset.browser_download_url, zip, asset.size);
    if (asset.digest?.startsWith('sha256:') && asset.digest.slice(7) !== sha256) throw new Error('The download is damaged (checksum mismatch)');

    set({ ...state, status: 'installing' });
    const unpacked = join(updateDir, 'files');
    mkdirSync(unpacked);
    // Windows 10+ ships bsdtar, which also reads zips.
    await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', unpacked]);
    const exe = basename(process.execPath);
    const source = findAppRoot(unpacked, exe);
    if (!source) throw new Error(`${exe} not found in the download`);

    // Waits for every Joule process (renderer and GPU helpers run the same exe), mirrors the new files over the app
    // folder except data/, and starts Joule again; on a failed copy the old version still starts.
    const target = process.execPath;
    const script = join(updateDir, 'apply.ps1');
    writeFileSync(script, [
      `$deadline = (Get-Date).AddSeconds(60)`,
      `while ((Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${ps(target)} }) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }`,
      `robocopy ${ps(source)} ${ps(appDir)} /MIR /XD ${ps(join(appDir, 'data'))} /R:10 /W:1 /NP /NFL /NDL /LOG:${ps(join(appDir, 'data', 'update.log'))}`,
      `Start-Process -FilePath ${ps(target)}`,
    ].join('\r\n'));
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    app.quit();
  } catch (e) {
    set({ ...state, status: 'error', error: (e as Error).message });
  }
}
