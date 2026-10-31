/** Features of the desktop app, from its preload (packages/electron/src/preload.ts); undefined in a browser or VS Code. */
import { useEffect, useState } from 'react';

/** Mirrors UpdateState in packages/electron/src/update.ts. */
export interface UpdateState {
  version: string;
  notesUrl: string;
  canInstall: boolean;
  status: 'available' | 'downloading' | 'installing' | 'error';
  progress?: number;
  error?: string;
}

interface JouleDesktop {
  getUpdate(): Promise<UpdateState | undefined>;
  installUpdate(): Promise<void>;
  onUpdate(fn: (s: UpdateState | undefined) => void): () => void;
}

export const desktop = (window as { jouleDesktop?: JouleDesktop }).jouleDesktop;

/** The newer release on GitHub, once the desktop app has found one. */
export function useUpdate() {
  const [update, setUpdate] = useState<UpdateState>();
  useEffect(() => {
    if (!desktop) return;
    void desktop.getUpdate().then(setUpdate);
    return desktop.onUpdate(setUpdate);
  }, []);
  return update;
}
