/** Gives the UI the few desktop-only features it needs, as `window.jouleDesktop` (see packages/ui/src/desktop.ts). */
import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateState } from './update';

contextBridge.exposeInMainWorld('jouleDesktop', {
  getUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:get'),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdate: (fn: (s: UpdateState) => void) => {
    const listener = (_e: unknown, s: UpdateState) => fn(s);
    ipcRenderer.on('update', listener);
    return () => void ipcRenderer.off('update', listener);
  },
});
