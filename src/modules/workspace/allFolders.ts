import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/** Whose requests an "access all folders" setting widens. */
type AllFoldersOrigin = "app" | "ai";

type AllFoldersSettings = Record<AllFoldersOrigin, boolean>;

/** The two settings as the preferences store holds them. */
type StoredSettings = { appAllFolders: boolean; aiAllFolders: boolean };

type Send = (origin: AllFoldersOrigin, all: boolean) => Promise<unknown>;

const ORIGINS: readonly AllFoldersOrigin[] = ["app", "ai"];

const sendToBackend: Send = (origin, all) =>
  invoke("workspace_set_all_folders", { origin, all });

/**
 * The settings this window last sent: previews load through the scheme that
 * matches what the backend serves.
 */
export const useAllFolders = create<AllFoldersSettings>(() => ({
  app: false,
  ai: false,
}));

/**
 * Tells the backend each setting it has not been told yet. A value that
 * failed to arrive is sent again with the next update.
 */
export function createAllFoldersSync(send: Send = sendToBackend) {
  const told: Partial<AllFoldersSettings> = {};
  return (settings: AllFoldersSettings): void => {
    for (const origin of ORIGINS) {
      const all = settings[origin] === true;
      if (told[origin] === all) continue;
      told[origin] = all;
      send(origin, all).catch((error: unknown) => {
        if (told[origin] === all) delete told[origin];
        console.warn("[workspace] folder access not applied", origin, error);
      });
    }
  };
}

/**
 * Keeps the backend's gates on the stored settings: the backend starts with
 * both off, so every window sends what it loaded and each change it sees,
 * whichever window made it.
 */
export function syncAllFolders(
  store: {
    getState(): StoredSettings;
    subscribe(listener: (state: StoredSettings) => void): () => void;
  },
  send: Send = sendToBackend,
): () => void {
  const update = createAllFoldersSync(send);
  const push = (state: StoredSettings) => {
    const settings = {
      app: state.appAllFolders === true,
      ai: state.aiAllFolders === true,
    };
    const shown = useAllFolders.getState();
    if (shown.app !== settings.app || shown.ai !== settings.ai) {
      useAllFolders.setState(settings);
    }
    update(settings);
  };
  push(store.getState());
  return store.subscribe(push);
}
