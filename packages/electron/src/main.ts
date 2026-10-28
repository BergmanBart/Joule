/** Electron shell: starts the UITester server in the main process and shows the UI in a window. */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, shell } from 'electron';
import { startServer } from '@uitester/server';

const here = fileURLToPath(new URL('.', import.meta.url));
let server: Awaited<ReturnType<typeof startServer>> | undefined;

async function createWindow() {
  server ??= await startServer({ port: 0, uiDir: join(here, 'ui'), projectDir: process.argv.find((a, i) => i > 1 && !a.startsWith('-')) });
  const win = new BrowserWindow({ width: 1600, height: 960, backgroundColor: '#1e1e1e', title: 'UITester', autoHideMenuBar: true });
  // Links such as Robot's log.html open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(server.url);
}

Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
app.on('window-all-closed', async () => {
  await server?.close();
  app.quit();
});
