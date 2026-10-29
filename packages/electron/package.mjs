// Packages the desktop app for Windows as release/Joule-<version>-win-x64.zip: unzip anywhere and run
// Joule.exe, nothing to install; settings are kept in a data/ folder next to the exe.
// (No single-file portable exe: it unpacks the whole app to a temp folder on every launch, ~30 s.)
import { build } from 'electron-builder';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import rcedit from 'rcedit';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

const self = json(here('package.json'));
const electronVersion = json(`${pkgDir('electron')}/package.json`).version;
const playwright = pkgDir('playwright-core');

// Stage a standalone app (bundled main + UI, and playwright-core, its only runtime dependency)
// so electron-builder doesn't have to make sense of the workspace.
const app = here('release/app');
rmSync(here('release'), { recursive: true, force: true });
mkdirSync(app, { recursive: true });
cpSync(here('dist'), `${app}/dist`, { recursive: true });
cpSync(playwright, `${app}/node_modules/playwright-core`, { recursive: true });
writeFileSync(`${app}/package.json`, JSON.stringify({
  name: 'joule',
  productName: 'Joule',
  version: self.version,
  description: 'Build, maintain and run UI tests visually; saved as Robot Framework files.',
  author: 'Joule',
  type: 'module',
  main: 'dist/main.js',
  dependencies: { 'playwright-core': json(`${playwright}/package.json`).version },
}, null, 2));

await build({
  projectDir: app,
  config: {
    appId: 'com.joule.desktop',
    productName: 'Joule',
    electronVersion,
    electronDist: `${pkgDir('electron')}/dist`,
    npmRebuild: false,
    // Python reads parse_robot.py from disk, which it can't do inside an asar archive.
    asar: false,
    directories: { output: here('release'), buildResources: here('build') },
    files: ['dist/**', 'package.json'],
    win: {
      target: ['zip'],
      icon: here('build/icon.ico'),
      // electron-builder's own exe editing needs a toolkit that only unpacks with Windows Developer Mode/admin
      // (and we don't sign), so the icon and version info are set with rcedit in afterPack instead.
      signAndEditExecutable: false,
    },
    artifactName: '${productName}-${version}-win-${arch}.${ext}',
    afterPack: async ({ appOutDir }) => {
      await rcedit(`${appOutDir}/Joule.exe`, {
        icon: here('build/icon.ico'),
        'file-version': self.version,
        'product-version': self.version,
        'version-string': { ProductName: 'Joule', FileDescription: 'Joule', CompanyName: 'Joule', OriginalFilename: 'Joule.exe' },
      });
    },
  },
});
console.log('release/ ready');
