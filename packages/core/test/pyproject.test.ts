import { describe, expect, it } from 'vitest';
import {
  BATTERIES_PKG,
  BROWSER_PKG,
  compareVersions,
  defaultPyproject,
  dependsOn,
  generateRobotFiles,
  lockedVersions,
  newProject,
  pinnedVersion,
  pythonProjectName,
  ROBOT_PKG,
} from '../src';

const LOCK = `version = 1
requires-python = ">=3.10"

[[package]]
name = "robotframework"
version = "7.5"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "robotframework-browser"
version = "20.6.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "robotframework" },
]

[[package]]
name = "robotframework-browser-batteries"
version = "20.5.1"
`;

describe('pyproject.toml and uv.lock', () => {
  it('writes a valid project name', () => {
    expect(pythonProjectName('My Shop — Checkout!')).toBe('my-shop-checkout');
    expect(pythonProjectName('***')).toBe('joule-tests');
    expect(defaultPyproject('My Shop')).toContain('name = "my-shop"');
  });

  it('lists the Robot packages without pins by default', () => {
    const toml = defaultPyproject('x');
    for (const p of [ROBOT_PKG, BROWSER_PKG, BATTERIES_PKG]) {
      expect(dependsOn(toml, p)).toBe(true);
      expect(pinnedVersion(toml, p)).toBeUndefined();
    }
  });

  it('reads pins without mixing up packages that share a prefix', () => {
    const toml = `dependencies = [\n    "robotframework-browser==20.6.0",\n    "robotframework-browser-batteries == 20.6.0",\n]`;
    expect(pinnedVersion(toml, BROWSER_PKG)).toBe('20.6.0');
    expect(pinnedVersion(toml, BATTERIES_PKG)).toBe('20.6.0');
    expect(pinnedVersion(toml, ROBOT_PKG)).toBeUndefined();
    expect(dependsOn(toml, ROBOT_PKG)).toBe(false);
    expect(dependsOn('"robotframework_Browser[extra]>=19"', BROWSER_PKG)).toBe(true);
  });

  it('reads the locked versions', () => {
    expect(lockedVersions(LOCK)).toEqual({ robotframework: '7.5', 'robotframework-browser': '20.6.0', 'robotframework-browser-batteries': '20.5.1' });
    expect(lockedVersions(LOCK.replace(/\n/g, '\r\n'))[BROWSER_PKG]).toBe('20.6.0');
  });

  it('compares versions numerically', () => {
    expect(compareVersions('20.10.0', '20.9.1')).toBeGreaterThan(0);
    expect(compareVersions('7.5', '7.5.0')).toBe(0);
    expect(['19.1.0', '20.6.0', '20.10.0'].sort((a, b) => compareVersions(b, a))).toEqual(['20.10.0', '20.6.0', '19.1.0']);
  });
});

describe('setup and run scripts', () => {
  it('installs the locked versions and the browser that goes with them', () => {
    const p = newProject('Shop', 'https://example.com');
    const files = generateRobotFiles(p);
    expect(files['setup.sh']).toContain('uv sync --locked');
    expect(files['setup.sh']).toContain('.venv/bin/python -m Browser.entry install chromium');
    expect(files['setup.bat']).toContain('.venv\\Scripts\\python.exe -m Browser.entry install chromium || exit /b 1');
    expect(files['run.bat']).toContain('if exist ".venv\\Scripts\\python.exe" set PY=.venv\\Scripts\\python.exe');
    expect(files['run.sh']).toContain('"$PY" -m robot -v "ENV:$ENV"');

    p.settings.browser = 'firefox';
    expect(generateRobotFiles(p)['setup.sh']).toContain('install firefox');
    p.settings.browser = 'msedge';
    expect(generateRobotFiles(p)['setup.bat']).not.toContain('Browser.entry install');
  });
});
