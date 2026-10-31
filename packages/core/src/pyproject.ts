/**
 * The Python environment that runs a project's Robot Framework tests, managed with uv: pyproject.toml holds the
 * versions the user picked, uv.lock the exact version of every package. Both live in the project folder, so an
 * exported project (or a CI pipeline) installs the same versions with `uv sync --locked`.
 */
import type { BrowserName } from './model';

export const PYPROJECT_FILE = 'pyproject.toml';
export const LOCK_FILE = 'uv.lock';

export const ROBOT_PKG = 'robotframework';
/** Its version decides the Playwright version and with that the browser builds (Chromium, Firefox) the tests run in. */
export const BROWSER_PKG = 'robotframework-browser';
/** The Browser library's Node.js side, prebuilt. Depends on robotframework-browser without a version, so Joule pins both to the same one. */
export const BATTERIES_PKG = 'robotframework-browser-batteries';
export const PABOT_PKG = 'robotframework-pabot';

/** Packages Joule pins to an exact version in pyproject.toml. */
export const PINNED_PKGS = [ROBOT_PKG, BROWSER_PKG, BATTERIES_PKG] as const;

/**
 * The Playwright browser the Browser library has to download for a project's browser setting. Edge runs as the
 * installed Edge (channel msedge), so there is nothing to download.
 */
export function browserToInstall(browser: BrowserName): 'chromium' | 'firefox' | undefined {
  return browser === 'msedge' ? undefined : browser;
}

/** A valid Python project name (PEP 508) for the [project] table. */
export function pythonProjectName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'joule-tests';
}

/** Written once when a project has no pyproject.toml; after that it belongs to the user (and to `uv add`). */
export function defaultPyproject(projectName: string): string {
  return [
    "# Python environment for this project's Robot Framework tests, managed with uv (https://docs.astral.sh/uv/).",
    '# Pick versions in Joule (Project settings → Robot Framework) or edit them here; uv.lock pins everything exactly.',
    '# The robotframework-browser version decides the Playwright version and the browser builds the tests run in;',
    '# robotframework-browser-batteries must have the same version.',
    '# Set up anywhere else (CI): setup.bat / setup.sh, which run `uv sync --locked` and install the matching browser.',
    '[project]',
    `name = "${pythonProjectName(projectName)}"`,
    'version = "0.0.0"',
    'requires-python = ">=3.10"',
    'dependencies = [',
    `    "${ROBOT_PKG}>=7",`,
    `    "${BROWSER_PKG}",`,
    `    "${BATTERIES_PKG}",`,
    `    "${PABOT_PKG}",`,
    ']',
    '',
    '[tool.uv]',
    '# Not a Python package: uv only installs the dependencies into .venv.',
    'package = false',
    '',
  ].join('\n');
}

/** Exact version of each package in uv.lock. */
export function lockedVersions(lock: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const m of lock.matchAll(/^\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/gm)) versions[m[1]] = m[2];
  return versions;
}

const namePattern = (pkg: string) => pkg.replace(/[-_.]+/g, '[-_.]+');

/** pyproject.toml lists the package as a dependency (in any form: pinned, a range, with extras). */
export function dependsOn(pyproject: string, pkg: string): boolean {
  return new RegExp(`["']${namePattern(pkg)}\\s*(?:[\\[<>=!~;"'])`, 'i').test(pyproject);
}

/** The version pyproject.toml pins a dependency to with `==`, if it does. */
export function pinnedVersion(pyproject: string, pkg: string): string | undefined {
  return new RegExp(`["']${namePattern(pkg)}\\s*==\\s*([^"',;\\s]+)`, 'i').exec(pyproject)?.[1];
}

/** Numeric comparison of release versions such as 20.6.0 and 20.10.1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
