import { detectEol, type Eol, normalizeToLf, restoreEol } from "./eol";
import { consumeRetarget } from "./pathRetarget";

export type ReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

export type DocumentIo = {
  read: (path: string, force: boolean) => Promise<ReadResult>;
  /** The file's mtime, or null when it cannot be stat'ed. */
  mtime: (path: string) => Promise<number | null>;
  /** Writes text already in the file's EOL and returns the new mtime. */
  write: (path: string, text: string) => Promise<number>;
};

export type DocumentHost = {
  state: (doc: DocumentState) => void;
  dirty: (dirty: boolean) => void;
  saved: (path: string) => void;
  /** The file changed on disk under unsaved edits; `overwrite` writes anyway. */
  conflict: (path: string, overwrite: () => void) => void;
  /** Notices tied to `path` no longer apply: the pane moved on or closed. */
  released: (path: string) => void;
  autoSave: () => { enabled: boolean; delay: number };
};

/**
 * One editor pane's document: the buffer, its saved baseline and the disk
 * state it was read from. Every async step remembers the epoch it started in
 * and is dropped once the pane loaded another file, was retargeted by a
 * rename, or closed, so a late result never lands on the wrong path.
 */
export class DocumentSession {
  private path: string | null = null;
  private active = false;
  private epoch = 0;
  // The path the buffer's text was read from; null while loading or non-text.
  private loadedPath: string | null = null;
  private saved = "";
  private text = "";
  private eol: Eol = "\n";
  private isDirty = false;
  private diskMtime: number | null = null;
  // "Open anyway" was chosen: reads of this file lift the size limit.
  private force = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly io: DocumentIo,
    private readonly host: DocumentHost,
  ) {}

  open(path: string): void {
    const prev = this.path;
    if (prev === path && this.active) return;
    this.active = true;
    this.path = path;
    if (prev !== null && prev !== path) {
      this.release(prev);
      // The explorer renamed or moved this file: keep the buffer, dirty
      // state, EOL and mtime (a move preserves it) instead of reloading. The
      // note is consumed either way so it cannot match a later path change.
      if (consumeRetarget(prev, path) && this.loadedPath === prev) {
        this.epoch += 1;
        this.loadedPath = path;
        this.armAutoSave();
        return;
      }
    }
    this.load(false);
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    this.epoch += 1;
    if (this.path !== null) this.release(this.path);
  }

  openAnyway = (): void => {
    if (this.active && this.path !== null) this.load(true);
  };

  change = (text: string): void => {
    this.text = text;
    this.setDirty(text !== this.saved);
    this.clearTimer();
    this.armAutoSave();
  };

  save = async (): Promise<boolean> => {
    this.clearTimer();
    if (this.text === this.saved) return true;
    return this.saveNow();
  };

  // Skipped while dirty: never clobber unsaved edits. Re-checked when the
  // read resolves, since typing can start while it is in flight.
  reload = (): boolean => {
    const path = this.path;
    if (!this.active || path === null || this.isDirty) return false;
    const epoch = this.epoch;
    this.io.read(path, this.force).then(
      (res) => {
        if (epoch === this.epoch && !this.isDirty) this.adopt(res, true);
      },
      // Transient failures (e.g. ENOENT mid atomic-rename) must not replace
      // a healthy buffer with an error screen.
      (e) => console.warn("[editor] reload failed", path, e),
    );
    return true;
  };

  // Adopts externally formatted disk content as the saved baseline before
  // the matching editor dispatch lands, so the buffer never flashes dirty.
  // The formatter's write becomes the known mtime, or the next save would
  // report it as an external conflict. Returns the LF text to dispatch.
  adoptDiskText = (diskText: string, mtime: number): string => {
    this.eol = detectEol(diskText);
    this.diskMtime = mtime;
    const content = normalizeToLf(diskText);
    this.saved = content;
    this.setDirty(this.text !== content);
    return content;
  };

  private load(force: boolean): void {
    const path = this.path;
    if (path === null) return;
    const epoch = ++this.epoch;
    this.force = force;
    this.loadedPath = null;
    this.saved = "";
    this.text = "";
    this.clearTimer();
    this.setDirty(false);
    this.host.state({ status: "loading" });
    this.io.read(path, force).then(
      (res) => {
        if (epoch === this.epoch) this.adopt(res);
      },
      (e) => {
        if (epoch === this.epoch) {
          this.host.state({ status: "error", message: String(e) });
        }
      },
    );
  }

  // `keepIfUnchanged` skips the re-render when disk already matches the
  // baseline (self-save, duplicate watcher event); loads always publish.
  private adopt(res: ReadResult, keepIfUnchanged = false): void {
    if (res.kind !== "text") {
      this.loadedPath = null;
      this.host.state(
        res.kind === "binary"
          ? { status: "binary", size: res.size }
          : { status: "toolarge", size: res.size, limit: res.limit },
      );
      return;
    }
    this.eol = detectEol(res.content);
    this.diskMtime = res.mtime;
    const content = normalizeToLf(res.content);
    if (
      keepIfUnchanged &&
      this.loadedPath === this.path &&
      content === this.saved
    ) {
      return;
    }
    this.loadedPath = this.path;
    this.saved = content;
    this.text = content;
    this.setDirty(false);
    this.host.state({ status: "ready", content, size: res.size });
  }

  // False when the write was withheld because the file changed on disk
  // since load; overwriting is an explicit user action from the notice.
  private async saveNow(): Promise<boolean> {
    const path = this.path;
    if (!this.active || path === null || this.loadedPath !== path) return false;
    const epoch = this.epoch;
    const known = this.diskMtime;
    if (known !== null) {
      const mtime = await this.io.mtime(path);
      if (epoch !== this.epoch) return false;
      if (mtime !== null && mtime !== known) {
        this.host.conflict(path, () => void this.write(epoch));
        return false;
      }
    }
    return this.write(epoch);
  }

  private async write(epoch: number): Promise<boolean> {
    const path = this.path;
    if (epoch !== this.epoch || path === null) return false;
    const content = this.text;
    const mtime = await this.io.write(path, restoreEol(content, this.eol));
    // Retargeted or closed while the write was in flight: the old path's
    // mtime is not this path's baseline, and the buffer stays dirty so the
    // next save lands on the current path.
    if (epoch !== this.epoch) return false;
    this.diskMtime = mtime;
    this.saved = content;
    // Edits typed while the write was in flight must stay dirty.
    this.setDirty(this.text !== content);
    this.host.saved(path);
    return true;
  }

  private armAutoSave(): void {
    if (!this.isDirty) return;
    const { enabled, delay } = this.host.autoSave();
    if (!enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow().catch((e) => console.error("[autosave]", e));
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private release(path: string): void {
    this.clearTimer();
    this.host.released(path);
  }

  private setDirty(dirty: boolean): void {
    this.isDirty = dirty;
    this.host.dirty(dirty);
  }
}
