/** Electron shell: starts the Joule server in the main process and shows the UI in a window. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, screen, shell, type IpcMainInvokeEvent, type Rectangle } from 'electron';
import { startServer } from '@joule/server';
import { getUpdate, installUpdate, startUpdateChecks } from './update';

const here = fileURLToPath(new URL('.', import.meta.url));

// Portable: a packaged build keeps settings and Chromium data in a data/ folder next to the exe.
if (app.isPackaged) {
  const data = join(dirname(process.execPath), 'data');
  process.env.JOULE_HOME = data;
  app.setPath('userData', join(data, 'electron'));
}
const WINDOW_FILE = join(process.env.JOULE_HOME || app.getPath('userData'), 'window.json');

let server: Awaited<ReturnType<typeof startServer>> | undefined;
let win: BrowserWindow | undefined;

interface WindowState {
  bounds?: Rectangle;
  maximized?: boolean;
}

function readWindowState(): WindowState {
  try {
    const s: WindowState = JSON.parse(readFileSync(WINDOW_FILE, 'utf8'));
    // Drop the saved position when that monitor is gone.
    const visible = s.bounds && screen.getAllDisplays().some(({ workArea: a }) =>
      s.bounds!.x < a.x + a.width && s.bounds!.x + s.bounds!.width > a.x && s.bounds!.y < a.y + a.height && s.bounds!.y + s.bounds!.height > a.y);
    return visible ? s : { maximized: s.maximized };
  } catch {
    return {};
  }
}

function saveWindowState(w: BrowserWindow) {
  try {
    mkdirSync(dirname(WINDOW_FILE), { recursive: true });
    writeFileSync(WINDOW_FILE, JSON.stringify({ bounds: w.getNormalBounds(), maximized: w.isMaximized() }));
  } catch {
    /* read-only location: just don't remember it */
  }
}

async function createWindow() {
  // `electron . <dir>` in development, `Joule.exe <dir>` when packaged.
  const projectDir = process.argv.find((a, i) => i >= (app.isPackaged ? 1 : 2) && !a.startsWith('-'));
  server ??= await startServer({ port: 0, uiDir: join(here, 'ui'), projectDir });
  const state = readWindowState();
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    ...state.bounds,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#1e1e1e',
    title: 'Joule',
    icon: join(here, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: join(here, 'preload.cjs') },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.on('close', () => win && saveWindowState(win));
  // Links such as Robot's log.html open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(server.url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  Menu.setApplicationMenu(null);
  // Only the UI from our own server may use the desktop bridge.
  const fromUi = (e: IpcMainInvokeEvent) => !!server && !!e.senderFrame?.url.startsWith(server.url);
  ipcMain.handle('update:get', (e) => (fromUi(e) ? getUpdate() : undefined));
  ipcMain.handle('update:install', (e) => (fromUi(e) ? installUpdate() : undefined));
  app.whenReady().then(async () => {
    await createWindow();
    if (app.isPackaged) startUpdateChecks((s) => win?.webContents.send('update', s));
  });
  app.on('window-all-closed', async () => {
    await server?.close();
    app.quit();
  });
}
