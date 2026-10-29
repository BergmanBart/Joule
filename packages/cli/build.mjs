// Bundles the CLI (core + engine + server) into dist/ with the built UI, so it can ship as one npx package.
import { build } from 'esbuild';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ui = here('../ui/dist');
if (!existsSync(`${ui}/index.html`)) throw new Error('Build the UI first: npm run build -w @joule/ui');

rmSync(here('dist'), { recursive: true, force: true });
await build({
  entryPoints: [here('src/cli.ts')],
  outfile: here('dist/cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // playwright-core is installed as a dependency; vite is only used with --dev; ws' native addons are optional
  external: ['playwright-core', 'vite', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
cpSync(here('../engine/src/overlay.js'), here('dist/overlay.js'));
cpSync(here('../engine/src/parse_robot.py'), here('dist/parse_robot.py'));
cpSync(ui, here('dist/ui'), { recursive: true });
console.log('dist/ ready');
