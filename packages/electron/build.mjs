// Bundles the Electron main process with the server, and copies the UI + engine assets next to it.
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
rmSync(here('dist'), { recursive: true, force: true });
await build({
  entryPoints: [here('src/main.ts')],
  outfile: here('dist/main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['electron', 'playwright-core', 'vite', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
cpSync(here('../engine/src/overlay.js'), here('dist/overlay.js'));
cpSync(here('../engine/src/parse_robot.py'), here('dist/parse_robot.py'));
cpSync(here('../ui/dist'), here('dist/ui'), { recursive: true });
cpSync(here('build/icon.png'), here('dist/icon.png'));
