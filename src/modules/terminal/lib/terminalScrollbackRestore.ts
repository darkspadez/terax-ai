import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  createScrollbackKey,
  encodeScrollbackFile,
  exportScrollback,
  isScrollbackKey,
  restoreSequence,
  SCROLLBACK_LIMITS,
  type ScrollbackLimits,
  type ScrollbackSource,
} from "@/modules/terminal/lib/terminalScrollback";
import { invoke } from "@tauri-apps/api/core";

/** How long new shell output waits for a restore that is still loading. */
const RESTORE_WAIT_MS = 2_000;
/** Shell output held while a restore loads; more gives the restore up. */
const RESTORE_HOLD_BYTES = 1024 * 1024;

export type ScrollbackModel = ScrollbackSource & {
  revision(): number;
  isDisposed?(): boolean;
};

export type ScrollbackBackend = {
  /** The stored file, empty when there is none. */
  load(key: string): Promise<string>;
  /** Replaces the stored file; an empty body deletes it. */
  save(key: string, body: string): Promise<void>;
  /** Deletes every stored file whose key is not listed. */
  retain(keys: readonly string[]): Promise<number>;
};

type ScrollbackSettings = {
  /** Settles once the stored preference is known (or could not be loaded). */
  ready(): Promise<void>;
  enabled(): boolean;
  subscribe(listener: () => void): () => void;
};

export type PendingScrollbackRestore = {
  /** The sequence to write first, null for none. Never rejects. */
  readonly result: Promise<string | null>;
  /** The result once it settled, undefined while loading. */
  settled(): string | null | undefined;
  /** The pane holds its restore (or gave it up) and may be saved again. */
  release(): void;
};

type RegistryOptions = {
  readonly backend: ScrollbackBackend;
  readonly settings: ScrollbackSettings;
  readonly model: (leafId: number) => ScrollbackModel | null;
  readonly now?: () => number;
  readonly newKey?: () => string;
  readonly formatDate?: (savedAt: number) => string;
  readonly limits?: ScrollbackLimits;
};

let dateFormat: Intl.DateTimeFormat | null = null;

function formatSavedAt(savedAt: number): string {
  dateFormat ??= new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return dateFormat.format(savedAt);
}

/**
 * Which pane owns which saved scrollback file, and when files are written,
 * restored and swept. Leaf ids change on every launch, so each pane gets a
 * random key that the space state stores with the leaf and hands back on the
 * next launch.
 */
export class TerminalScrollbackRegistry {
  private readonly keys = new Map<number, string>();
  /** Adopted at launch, restore not yet taken. */
  private readonly pending = new Map<number, string>();
  /** Restore taken but not yet in the model: saving now would lose it. */
  private readonly restoring = new Set<number>();
  /**
   * Adopted leaves no persisted tab list has named yet. Their keys survive a
   * sweep, so a list taken before the restored tabs are in place cannot
   * delete their history.
   */
  private readonly unconfirmed = new Set<number>();
  /** Model revision last saved; weak, so a disposed model is never retained. */
  private saved = new WeakMap<object, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private purged = false;
  private source: (() => readonly number[]) | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: RegistryOptions) {}

  keyForLeaf(leafId: number): string | undefined {
    return this.keys.get(leafId);
  }

  /** A restored leaf takes over the key its pane had before the restart. */
  adopt(leafId: number, key: unknown): void {
    if (!isScrollbackKey(key) || this.keys.has(leafId)) return;
    for (const owned of this.keys.values()) if (owned === key) return;
    this.keys.set(leafId, key);
    this.pending.set(leafId, key);
    this.unconfirmed.add(leafId);
  }

  /** Starts loading a restored leaf's history; at most once per leaf. */
  takeRestore(leafId: number): PendingScrollbackRestore | null {
    const key = this.pending.get(leafId);
    if (key === undefined) return null;
    this.pending.delete(leafId);
    this.restoring.add(leafId);
    let value: string | null | undefined;
    const result = this.loadRestore(key).then(
      (text) => {
        value = text;
        return text;
      },
      (error: unknown) => {
        console.warn("[terax] could not restore terminal scrollback:", error);
        value = null;
        return null;
      },
    );
    return {
      result,
      settled: () => value,
      release: () => {
        this.restoring.delete(leafId);
      },
    };
  }

  /**
   * Gives every live listed pane a key (synchronously, so the caller can
   * store it with the tab state), then saves changed panes and sweeps the
   * files of panes that are gone. `leafIds` are all panes whose tabs persist:
   * private tabs are never listed, so they are never saved and lose any file.
   */
  persist(
    leafIds: readonly number[],
    { assignKeys = true }: { assignKeys?: boolean } = {},
  ): Promise<void> {
    const listed = new Set(leafIds);
    for (const leafId of leafIds) this.unconfirmed.delete(leafId);
    for (const leafId of [...this.keys.keys()]) {
      if (!listed.has(leafId) && !this.unconfirmed.has(leafId)) {
        this.forget(leafId);
      }
    }
    if (assignKeys && this.options.settings.enabled()) {
      for (const leafId of leafIds) {
        if (!this.keys.has(leafId) && this.liveModel(leafId)) {
          this.keys.set(
            leafId,
            this.options.newKey?.() ?? createScrollbackKey(this.now()),
          );
        }
      }
    }
    const targets = leafIds.filter((leafId) => this.keys.has(leafId));
    return this.enqueue(() => this.write(targets));
  }

  /**
   * Supplies the current persisted leaves for close-time saves and setting
   * changes. Until one is attached (spaces not restored yet) nothing is swept.
   */
  attachLeafSource(source: () => readonly number[]): () => void {
    this.unsubscribe?.();
    this.source = source;
    this.unsubscribe = this.options.settings.subscribe(() => {
      if (this.source === source)
        void this.persist(source(), { assignKeys: false });
    });
    return () => {
      if (this.source !== source) return;
      this.source = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
    };
  }

  /**
   * Close-time save of panes that already have keys. Never rejects and never
   * waits longer than `timeoutMs`, so closing cannot hang on it.
   */
  async flush(timeoutMs: number): Promise<{ timedOut: boolean }> {
    const source = this.source;
    if (!source) return { timedOut: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    });
    const done = Promise.resolve()
      .then(() => this.persist(source(), { assignKeys: false }))
      .then(
        () => false,
        () => false,
      );
    try {
      return { timedOut: await Promise.race([done, timedOut]) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private forget(leafId: number): void {
    this.keys.delete(leafId);
    this.pending.delete(leafId);
    this.restoring.delete(leafId);
    this.unconfirmed.delete(leafId);
  }

  private liveModel(leafId: number): ScrollbackModel | null {
    const model = this.options.model(leafId);
    return model && !model.isDisposed?.() ? model : null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async loadRestore(key: string): Promise<string | null> {
    const { backend, settings } = this.options;
    await settings.ready();
    if (!settings.enabled()) return null;
    const file = await backend.load(key);
    if (!file) return null;
    return restoreSequence(
      file,
      this.options.formatDate ?? formatSavedAt,
      this.options.limits ?? SCROLLBACK_LIMITS,
    );
  }

  private async write(targets: readonly number[]): Promise<void> {
    const { backend, settings } = this.options;
    await settings.ready();
    if (!settings.enabled()) {
      if (this.purged) return;
      try {
        await backend.retain([]);
        this.purged = true;
        this.saved = new WeakMap();
      } catch (error) {
        console.warn("[terax] could not delete terminal scrollback:", error);
      }
      return;
    }
    this.purged = false;
    let failure: unknown = null;
    for (const leafId of targets) {
      const key = this.keys.get(leafId);
      if (!key || this.restoring.has(leafId)) continue;
      const model = this.liveModel(leafId);
      if (!model) continue;
      try {
        const revision = model.revision();
        if (this.saved.get(model) === revision) continue;
        const history = exportScrollback(
          model,
          this.options.limits ?? SCROLLBACK_LIMITS,
        );
        if (history === null) continue;
        await backend.save(
          key,
          history ? encodeScrollbackFile(history, this.now()) : "",
        );
        this.saved.set(model, revision);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await backend.retain([...new Set(this.keys.values())]);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== null) {
      console.warn("[terax] could not save terminal scrollback:", failure);
    }
  }
}

const textEncoder = new TextEncoder();

/**
 * Orders a restored pane's history before its new shell's output. Output that
 * arrives while the history is still loading is held (bounded in time and
 * size, past which the restore is given up) and follows it in order. Connect
 * the sink before the model is published: a restore that already settled is
 * written at once, so no save can see the model without it.
 */
export class ScrollbackRestoreGate {
  private sink: ((bytes: Uint8Array) => void) | null = null;
  private restored: string | null | undefined;
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  private open = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly restore: PendingScrollbackRestore | null,
    private readonly limits: {
      readonly waitMs: number;
      readonly holdBytes: number;
    } = { waitMs: RESTORE_WAIT_MS, holdBytes: RESTORE_HOLD_BYTES },
  ) {
    if (!restore) {
      this.restored = null;
      return;
    }
    const settled = restore.settled();
    if (settled !== undefined) {
      this.settle(settled);
      return;
    }
    this.timer = setTimeout(() => this.settle(null), limits.waitMs);
    void restore.result.then((text) => this.settle(text));
  }

  connect(sink: (bytes: Uint8Array) => void): void {
    this.sink = sink;
    this.drain();
  }

  write(bytes: Uint8Array): void {
    if (this.open && this.sink) {
      this.sink(bytes);
      return;
    }
    this.held.push(bytes);
    this.heldBytes += bytes.byteLength;
    if (this.heldBytes > this.limits.holdBytes) this.settle(null);
    this.drain();
  }

  private settle(text: string | null): void {
    if (this.restored !== undefined) return;
    this.restored = text;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.restore?.release();
    this.drain();
  }

  private drain(): void {
    const sink = this.sink;
    if (!sink || this.restored === undefined) return;
    const text = this.restored;
    this.restored = null;
    if (text) sink(textEncoder.encode(text));
    const held = this.held;
    this.held = [];
    this.heldBytes = 0;
    for (const chunk of held) sink(chunk);
    this.open = true;
  }
}

const textDecoder = new TextDecoder();

const nativeBackend: ScrollbackBackend = {
  async load(key) {
    const buffer = await invoke<ArrayBuffer>("terminal_scrollback_load", {
      key,
    });
    return buffer.byteLength === 0 ? "" : textDecoder.decode(buffer);
  },
  async save(key, body) {
    await invoke("terminal_scrollback_save", textEncoder.encode(body), {
      headers: { "x-terax-scrollback": key },
    });
  },
  retain: (keys) => invoke<number>("terminal_scrollback_retain", { keys }),
};

// Turning the setting off deletes every file, so only an explicit false does.
function restoreEnabled(state: {
  readonly terminalBehavior?: { readonly restoreScrollback?: unknown };
}): boolean {
  return state.terminalBehavior?.restoreScrollback !== false;
}

const preferenceSettings: ScrollbackSettings = {
  ready: () =>
    usePreferencesStore
      .getState()
      .init()
      .catch(() => undefined),
  enabled: () => restoreEnabled(usePreferencesStore.getState()),
  subscribe: (listener) =>
    usePreferencesStore.subscribe((state, previous) => {
      if (restoreEnabled(state) !== restoreEnabled(previous)) listener();
    }),
};

let modelSource: (leafId: number) => ScrollbackModel | null = () => null;

/** The session owner tells the registry where each leaf's model lives. */
export function setScrollbackModelSource(
  source: (leafId: number) => ScrollbackModel | null,
): void {
  modelSource = source;
}

export const terminalScrollback = new TerminalScrollbackRegistry({
  backend: nativeBackend,
  settings: preferenceSettings,
  model: (leafId) => modelSource(leafId),
});

export function scrollbackKeyForLeaf(leafId: number): string | undefined {
  return terminalScrollback.keyForLeaf(leafId);
}

export function adoptScrollbackKey(leafId: number, key: unknown): void {
  terminalScrollback.adopt(leafId, key);
}

export function flushTerminalScrollback(
  timeoutMs: number,
): Promise<{ timedOut: boolean }> {
  return terminalScrollback.flush(timeoutMs);
}
