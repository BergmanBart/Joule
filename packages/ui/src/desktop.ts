/** Features of the desktop app, from its preload (packages/electron/src/preload.ts); undefined in a browser or VS Code. */
import { useEffect, useState } from 'react';
import { save, toast, useStore } from './store';

/** Mirrors UpdateState in packages/electron/src/update.ts. */
export interface UpdateState {
  current: string;
  checking: boolean;
  checkedAt?: number;
  checkError?: string;
  available?: {
    version: string;
    notesUrl: string;
    blocked?: string;
    status: 'idle' | 'downloading' | 'installing' | 'error';
    progress?: number;
    error?: string;
  };
}

interface JouleDesktop {
  getUpdate(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  onUpdate(fn: (s: UpdateState) => void): () => void;
}

export const desktop = (window as { jouleDesktop?: JouleDesktop }).jouleDesktop;

/** The desktop app's version and update status; undefined outside the desktop app. */
export function useUpdate() {
  const [update, setUpdate] = useState<UpdateState>();
  useEffect(() => {
    if (!desktop) return;
    void desktop.getUpdate().then(setUpdate);
    return desktop.onUpdate(setUpdate);
  }, []);
  return update;
}

/** Saves first: quitting with unsaved changes would be blocked (and lose them). */
export async function installUpdate() {
  await save();
  if (useStore.getState().dirty) return toast('Save your changes before updating', 'error');
  await desktop?.installUpdate();
}
