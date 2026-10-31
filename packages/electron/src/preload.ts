/** Gives the UI the few desktop-only features it needs, as `window.jouleDesktop` (see packages/ui/src/desktop.ts). */
import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateState } from './update';

contextBridge.exposeInMainWorld('jouleDesktop', {
  getUpdate: (): Promise<UpdateState | undefined> => ipcRenderer.invoke('update:get'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdate: (fn: (s: UpdateState | undefined) => void) => {
    const listener = (_e: unknown, s: UpdateState | undefined) => fn(s);
    ipcRenderer.on('update', listener);
    return () => void ipcRenderer.off('update', listener);
  },
});
