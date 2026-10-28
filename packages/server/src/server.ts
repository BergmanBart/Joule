import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, parse, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  findStep,
  newProject,
  pickSteps,
  resolveParameters,
  type AppSettings,
  type Events,
  type EventType,
  type FsEntry,
  type Project,
  type Requests,
  type RequestType,
} from '@uitester/core';
import { externallyEdited, isProjectDir, loadProject, saveProject } from '@uitester/core/node';
import {
  BrowserSession,
  checkDeps,
  importFolder,
  installCommands,
  installDeps,
  LiveRunner,
  RobotRun,
  timestamp,
  findPython,
  type StepEvent,
} from '@uitester/engine';

const SETTINGS_FILE = join(homedir(), '.uitester', 'settings.json');

type Handler<K extends RequestType> = (payload: Requests[K][0]) => Promise<Requests[K][1]>;

export interface ServerOptions {
  port: number;
  host?: string;
  /** Folder with the built UI (index.html). */
  uiDir?: string;
  /** Use Vite in middleware mode (development). */
  dev?: { root: string };
  /** Open this project on startup. */
  projectDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function readSettings(): Promise<AppSettings> {
  try {
    return { recent: [], ...JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { recent: [] };
  }
}

async function writeSettings(s: AppSettings): Promise<void> {
  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

export async function startServer(opts: ServerOptions) {
  let settings = await readSettings();
  let projectDir: string | undefined;
  let project: Project | undefined;
  const clients = new Set<WebSocket>();
  const session = new BrowserSession();
  let liveAbort: AbortController | undefined;
  let pauseResolve: (() => void) | undefined;
  let robotRun: RobotRun | undefined;

  const emit = <E extends EventType>(event: E, data: Events[E]) => {
    const msg = JSON.stringify({ event, data });
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  };

  session.on('frame', (f) => emit('view.frame', f));
  session.on('pick', (d) => emit('view.pick', { descriptor: d }));
  session.on('url', (url) => emit('view.url', { url }));
  session.on('closed', () => emit('view.status', { state: 'closed' }));

  const requireProject = () => {
    if (!projectDir) throw new Error('No project is open');
    return projectDir;
  };

  async function remember(dir: string) {
    settings = { ...settings, lastProject: dir, recent: [dir, ...settings.recent.filter((d) => d !== dir)].slice(0, 10) };
    await writeSettings(settings);
  }

  async function python() {
    const py = await findPython(projectDir ?? process.cwd(), settings.pythonPath);
    if (!py) throw new Error('Python 3 was not found. Open the dependency check in Settings.');
    return py;
  }

  async function open(dir: string) {
    dir = resolve(dir);
    let imported = false;
    let warnings: string[] = [];
    let edits: string[] = [];
    if (isProjectDir(dir)) {
      project = await loadProject(dir);
      edits = await externallyEdited(dir, project);
    } else {
      // Not created by UITester: try to read the Robot files in it.
      const r = await importFolder(dir, await python());
      project = r.project;
      warnings = r.warnings;
      imported = true;
    }
    projectDir = dir;
    await remember(dir);
    return { dir, project: project!, externalEdits: edits, imported, warnings };
  }

  const handlers: { [K in RequestType]: Handler<K> } = {
    'app.state': async () => {
      if (!projectDir && opts.projectDir) {
        try {
          await open(opts.projectDir);
        } catch {
          /* show the start screen */
        }
      }
      return {
        settings,
        projectDir,
        project,
        externalEdits: projectDir && project ? await externallyEdited(projectDir, project) : [],
        home: homedir(),
        cwd: process.cwd(),
      };
    },
    'app.saveSettings': async ({ settings: s }) => {
      settings = s;
      await writeSettings(s);
      return s;
    },
    'fs.list': async ({ dir }) => {
      if (!dir && process.platform === 'win32') {
        const drives: FsEntry[] = [];
        for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (existsSync(`${l}:\\`)) drives.push({ name: `${l}:`, path: `${l}:\\`, isDir: true, isProject: false });
        return { dir: '', entries: drives };
      }
      const abs = resolve(dir || homedir());
      const items = await readdir(abs, { withFileTypes: true }).catch(() => []);
      const entries: FsEntry[] = items
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => ({ name: e.name, path: join(abs, e.name), isDir: true, isProject: isProjectDir(join(abs, e.name)) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const root = parse(abs).root;
      const parent = abs === root ? (process.platform === 'win32' ? '' : undefined) : dirname(abs);
      return { dir: abs, parent, entries };
    },
    'fs.mkdir': async ({ dir }) => {
      await mkdir(dir, { recursive: true });
      return { dir };
    },
    'project.create': async ({ dir, name, url }) => {
      dir = resolve(dir);
      if (isProjectDir(dir)) throw new Error('This folder already contains a UITester project');
      await mkdir(dir, { recursive: true });
      project = await saveProject(dir, newProject(name, url));
      projectDir = dir;
      await remember(dir);
      return { dir, project };
    },
    'project.open': async ({ dir }) => open(dir),
    'project.save': async ({ project: p }) => {
      project = await saveProject(requireProject(), p);
      return project;
    },
    'project.reimport': async () => {
      const dir = requireProject();
      const r = await importFolder(dir, await python(), project);
      project = r.project;
      return r;
    },

    'view.start': async ({ browser, width, height, url }) => {
      emit('view.status', { state: 'starting' });
      try {
        await session.start({ browser, width, height }, url);
        emit('view.status', { state: 'ready' });
      } catch (e) {
        emit('view.status', { state: 'error', message: (e as Error).message.split('\n')[0] });
        throw e;
      }
      return {};
    },
    'view.navigate': async ({ url }) => (await session.navigate(url), {}),
    'view.reload': async () => (await session.reload(), {}),
    'view.back': async () => (await session.back(), {}),
    'view.mode': async ({ mode }) => (await session.setMode(liveAbort ? 'run' : mode), {}),
    'view.mouse': async (m) => (await session.mouse(m), {}),
    'view.key': async (k) => (await session.key(k), {}),
    'view.highlights': async ({ items }) => (await session.setHighlights(items), {}),
    'view.count': async ({ selector }) => {
      const r = await session.count(selector);
      return typeof r === 'number' ? { count: r } : { count: 0, error: r.error };
    },

    'run.live': async ({ project: p, testId, stepIds, fromStart }) => {
      if (liveAbort || robotRun) throw new Error('A run is already in progress');
      const dir = requireProject();
      // A test, or a reusable keyword being edited on its own.
      const asTest = p.tests.find((t) => t.id === testId);
      const test = asTest ?? p.keywords.find((k) => k.id === testId);
      if (!test) throw new Error('Unknown test');
      if (!session.isOpen || !session.page) throw new Error('The browser view is not running');
      const params = Object.fromEntries(resolveParameters(p, asTest).map((x) => [x.name, x.value]));
      const steps = stepIds ? pickSteps(test.steps, new Set(stepIds)) : test.steps;
      const abort = new AbortController();
      liveAbort = abort;
      const previousMode = session.getMode();
      await session.setMode('run');
      const events: (StepEvent & { at: string })[] = [];
      emit('run.started', { kind: 'live', testIds: [testId] });
      void (async () => {
        let ok = false;
        let message: string | undefined;
        try {
          if (fromStart) await session.navigate(params.URL ?? 'about:blank');
          ok = await new LiveRunner({
            page: session.page!,
            steps,
            keywords: p.keywords,
            params,
            timeoutSeconds: p.settings.timeoutSeconds,
            projectDir: dir,
            screenshotDir: p.settings.screenshotDir,
            signal: abort.signal,
            onStep: (e) => {
              events.push({ ...e, at: new Date().toISOString() });
              emit('run.step', e);
            },
            onPause: (stepId, msg) =>
              new Promise<void>((resolveP) => {
                pauseResolve = resolveP;
                emit('run.paused', { stepId, message: msg });
                abort.signal.addEventListener('abort', () => resolveP(), { once: true });
              }).then(() => emit('run.resumed', {})),
          }).run();
        } catch (e) {
          message = (e as Error).message;
        } finally {
          liveAbort = undefined;
          pauseResolve = undefined;
          await session.setMode(previousMode === 'run' ? 'interact' : previousMode);
          const logDir = join('logs', `${timestamp()}-live`);
          await mkdir(join(dir, logDir), { recursive: true });
          const names = Object.fromEntries(events.map((e) => [e.id, findStep(test.steps, e.id)?.name ?? '']));
          await writeFile(
            join(dir, logDir, 'live-log.json'),
            JSON.stringify({ test: test.name, testId, ok: ok && !abort.signal.aborted, message, partial: !!stepIds, events, names }, null, 2),
          );
          emit('run.done', { kind: 'live', ok: ok && !abort.signal.aborted, logDir, message: abort.signal.aborted ? 'Stopped' : message });
        }
      })();
      return {};
    },
    'run.robot': async ({ project: p, testIds, headless, parallel }) => {
      if (liveAbort || robotRun) throw new Error('A run is already in progress');
      const dir = requireProject();
      const deps = await checkDeps(dir, settings.pythonPath);
      if (!deps.ok || !deps.python) throw new Error('DEPS: Robot Framework with the Browser library is not installed for this project.');
      project = await saveProject(dir, p);
      const run = new RobotRun({
        projectDir: dir,
        project,
        python: deps.python.path,
        testIds,
        env: p.settings.environment,
        headless: headless ?? p.settings.headless,
        parallel: parallel ?? true,
        onLine: (line) => emit('run.output', { line }),
        onPause: (message) => emit('run.paused', { message }),
      });
      robotRun = run;
      emit('run.started', { kind: 'robot', testIds: testIds ?? p.tests.map((t) => t.id) });
      void run
        .run()
        .then((r) => emit('run.done', { kind: 'robot', ok: r.ok, logDir: r.logDir, results: r.results }))
        .catch((e: Error) => emit('run.done', { kind: 'robot', ok: false, message: e.message }))
        .finally(() => (robotRun = undefined));
      return {};
    },
    'run.continue': async () => {
      pauseResolve?.();
      pauseResolve = undefined;
      robotRun?.continue();
      if (robotRun) emit('run.resumed', {});
      return {};
    },
    'run.stop': async () => {
      liveAbort?.abort();
      robotRun?.stop();
      return {};
    },

    'deps.check': async () => {
      const dir = projectDir ?? process.cwd();
      const status = await checkDeps(dir, settings.pythonPath);
      return { ...status, installCommands: installCommands(dir, project?.settings.browser === 'msedge') };
    },
    'deps.install': async ({ skipBrowsers }) => {
      const dir = requireProject();
      const ok = await installDeps(dir, skipBrowsers, (line) => emit('deps.output', { line }));
      return { ok };
    },
  };

  // ---------- HTTP ----------

  let vite: { middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void } | undefined;
  if (opts.dev) {
    const { createServer: createVite } = await import('vite');
    vite = await createVite({ root: opts.dev.root, server: { middlewareMode: true, hmr: { port: opts.port + 1 } }, appType: 'spa' });
  }

  async function sendFile(res: ServerResponse, path: string) {
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Project files (logs, screenshots) so the UI can open log.html.
    if (url.pathname.startsWith('/project-files/') && projectDir) {
      const rel = normalize(decodeURIComponent(url.pathname.slice('/project-files/'.length)));
      const abs = resolve(projectDir, rel);
      if (abs.startsWith(projectDir + sep) && (await sendFile(res, abs))) return;
      res.writeHead(404).end('Not found');
      return;
    }
    if (vite) {
      vite.middlewares(req, res, () => res.writeHead(404).end());
      return;
    }
    if (opts.uiDir) {
      const rel = normalize(url.pathname).replace(/^([/\\])+/, '');
      const abs = resolve(opts.uiDir, rel || 'index.html');
      if (abs.startsWith(resolve(opts.uiDir)) && rel && (await sendFile(res, abs))) return;
      if (await sendFile(res, join(opts.uiDir, 'index.html'))) return;
    }
    res.writeHead(404).end('UI not built');
  });

  const wss = new WebSocketServer({ server: http, path: '/ws' });
  wss.on('connection', (ws, req) => {
    // Only accept the UI served from this server (blocks other websites from driving it).
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !origin.startsWith('vscode-webview://') && origin !== 'file://') {
      ws.close(1008, 'origin not allowed');
      return;
    }
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', async (raw) => {
      let msg: { id: number; type: RequestType; payload: any };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const handler = handlers[msg.type] as Handler<RequestType> | undefined;
      try {
        if (!handler) throw new Error(`Unknown request ${msg.type}`);
        const result = await handler(msg.payload ?? {});
        ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: (e as Error).message }));
      }
    });
  });

  await new Promise<void>((r) => http.listen(opts.port, opts.host ?? '127.0.0.1', r));
  // port 0 = any free port (used by the VS Code and Electron shells)
  const address = `http://${opts.host ?? '127.0.0.1'}:${(http.address() as AddressInfo).port}/`;

  return {
    url: address,
    async close() {
      await session.stop();
      robotRun?.stop();
      wss.close();
      await new Promise((r) => http.close(r));
    },
  };
}
