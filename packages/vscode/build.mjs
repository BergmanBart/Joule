// Bundles the extension with the server, and copies the UI + engine assets next to it.
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
rmSync(here('dist'), { recursive: true, force: true });
await build({
  entryPoints: [here('src/extension.ts')],
  outfile: here('dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode', 'playwright-core', 'vite', 'bufferutil', 'utf-8-validate'],
  // the engine locates overlay.js / parse_robot.py via import.meta.url
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
});
cpSync(here('../engine/src/overlay.js'), here('dist/overlay.js'));
cpSync(here('../engine/src/parse_robot.py'), here('dist/parse_robot.py'));
cpSync(here('../ui/dist'), here('dist/ui'), { recursive: true });
