import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENTS, type Environment } from '@joule/core';
import { isProjectDir, loadProject, saveProject } from '@joule/core/node';
import { checkDeps, findPython, installCommands, RobotRun } from '@joule/engine';
import { startServer } from '@joule/server';

const HELP = `Joule — build and run UI tests that are saved as Robot Framework files.

Usage:
  joule [project-dir] [--port 4321] [--no-open]
      Start the app (opens in your browser).
  joule run [project-dir] [--tests "Name A,Name B"] [--env TEST] [--headless] [--serial]
      Run tests with Robot Framework without the UI. Exit code 0 when all pass.
`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const next = argv[i + 1];
      if (v !== undefined) flags[k] = v;
      else if (next && !next.startsWith('--') && ['port', 'tests', 'env', 'host'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}

/** Bundled builds ship the UI next to the CLI; in the monorepo it is packages/ui/dist. */
function uiDir(): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const candidate of [resolve(here, 'ui'), resolve(here, '../../ui/dist')]) {
    if (existsSync(resolve(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

async function run(dir: string, flags: Record<string, string | boolean>): Promise<number> {
  if (!isProjectDir(dir)) {
    console.error(`No Joule project (joule.json) in ${dir}`);
    return 2;
  }
  let project = await loadProject(dir);
  const env = (typeof flags.env === 'string' ? flags.env.toUpperCase() : project.settings.environment) as Environment;
  if (!ENVIRONMENTS.includes(env)) {
    console.error(`Unknown environment ${env}. Use one of ${ENVIRONMENTS.join(', ')}.`);
    return 2;
  }
  const deps = await checkDeps(dir);
  if (!deps.ok || !deps.python) {
    console.error('Robot Framework with the Browser library is not installed. Install it with:\n');
    console.error(installCommands(dir, project.settings.browser === 'msedge').join('\n'));
    return 2;
  }
  let testIds: string[] | undefined;
  if (typeof flags.tests === 'string') {
    const names = flags.tests.split(',').map((s) => s.trim().toLowerCase());
    testIds = project.tests.filter((t) => names.includes(t.name.toLowerCase())).map((t) => t.id);
    if (!testIds.length) {
      console.error(`No tests named ${flags.tests}`);
      return 2;
    }
  }
  project = await saveProject(dir, project); // make sure the .robot files match joule.json
  const result = await new RobotRun({
    projectDir: dir,
    project,
    python: deps.python.path ?? (await findPython(dir))!,
    testIds,
    env,
    headless: flags.headless === true || project.settings.headlessRunAll,
    parallel: !flags.serial,
    onLine: (l) => console.log(l),
    onPause: (m) => console.log(`[paused] ${m} (press Enter)`),
  }).run();
  process.stdin.pause();
  console.log(`\nLogs: ${resolve(dir, result.logDir)}`);
  for (const r of result.results) console.log(`${r.status.padEnd(5)} ${r.name}${r.message ? `  — ${r.message}` : ''}`);
  return result.ok ? 0 : 1;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(HELP);
    return;
  }
  if (positional[0] === 'run') {
    process.exitCode = await run(resolve(positional[1] ?? '.'), flags);
    return;
  }
  const port = Number(flags.port ?? 4321);
  const dev = flags.dev === true;
  const projectDir = positional[0] ? resolve(positional[0]) : undefined;
  const server = await startServer({
    port,
    host: typeof flags.host === 'string' ? flags.host : undefined,
    projectDir,
    uiDir: dev ? undefined : uiDir(),
    dev: dev ? { root: fileURLToPath(new URL('../../ui', import.meta.url)) } : undefined,
  });
  console.log(`Joule is running at ${server.url}`);
  if (!dev && !uiDir()) console.log('Note: the UI is not built yet. Run `npm run build` (or start with --dev).');
  if (!flags['no-open']) openBrowser(server.url);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
