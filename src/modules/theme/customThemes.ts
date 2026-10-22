import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { Theme } from "./types";

const STORE_PATH = "terax-custom-themes.json";
const KEY = "themes";
const CHANGED_EVENT = "terax://custom-themes-changed";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function listCustomThemes(): Promise<Theme[]> {
  const v = await store.get<Theme[]>(KEY);
  return Array.isArray(v) ? v : [];
}

export async function saveCustomTheme(theme: Theme): Promise<void> {
  await saveCustomThemes([theme]);
}

/** Upserts by id in one store write; a later duplicate id wins. */
export async function saveCustomThemes(
  themes: readonly Theme[],
): Promise<void> {
  if (themes.length === 0) return;
  const incoming = new Map(themes.map((t) => [t.id, t]));
  const current = await listCustomThemes();
  const next = current
    .filter((t) => !incoming.has(t.id))
    .concat([...incoming.values()]);
  await store.set(KEY, next);
  await store.save();
  await emit(CHANGED_EVENT);
}

export async function deleteCustomTheme(id: string): Promise<void> {
  const current = await listCustomThemes();
  const next = current.filter((t) => t.id !== id);
  if (next.length === current.length) return;
  await store.set(KEY, next);
  await store.save();
  await emit(CHANGED_EVENT);
}

export async function onCustomThemesChange(cb: () => void): Promise<UnlistenFn> {
  const unsubLocal = await store.onChange((key) => {
    if (key === KEY) cb();
  });
  const unsubEvent = await listen(CHANGED_EVENT, () => cb());
  return () => {
    unsubLocal();
    unsubEvent();
  };
}
