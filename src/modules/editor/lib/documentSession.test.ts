import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DocumentIo,
  DocumentSession,
  type DocumentState,
} from "./documentSession";
import { consumeRetarget, noteRetarget } from "./pathRetarget";

type Op = "read" | "mtime" | "write";

function createDisk(files: Record<string, string>) {
  let clock = 100;
  const disk = new Map<string, { content: string; mtime: number }>();
  for (const [path, content] of Object.entries(files)) {
    disk.set(path, { content, mtime: ++clock });
  }
  const log: string[] = [];
  const held = new Map<Op, Array<() => void>>();
  const holds = new Set<Op>();
  const failures = new Map<string, string>();
  const gate = async (op: Op) => {
    if (!holds.has(op)) return;
    await new Promise<void>((resolve) => {
      const queue = held.get(op) ?? [];
      queue.push(resolve);
      held.set(op, queue);
    });
  };
  const io: DocumentIo = {
    read: async (path, force) => {
      log.push(`read ${path}${force ? " force" : ""}`);
      await gate("read");
      const file = disk.get(path);
      if (!file) throw new Error(`ENOENT ${path}`);
      return {
        kind: "text",
        content: file.content,
        size: file.content.length,
        mtime: file.mtime,
      };
    },
    mtime: async (path) => {
      log.push(`stat ${path}`);
      await gate("mtime");
      return disk.get(path)?.mtime ?? null;
    },
    write: async (path, text) => {
      log.push(`write ${path}`);
      await gate("write");
      const failure = failures.get(path);
      if (failure) throw new Error(failure);
      disk.set(path, { content: text, mtime: ++clock });
      return clock;
    },
  };
  return {
    disk,
    io,
    log,
    failures,
    /** Later calls of `op` wait until `release(op)`. */
    hold: (op: Op) => holds.add(op),
    release: (op: Op) => {
      holds.delete(op);
      for (const resolve of held.get(op) ?? []) resolve();
      held.delete(op);
    },
    /** Another program writes the file (or only bumps its mtime). */
    touch: (path: string, content?: string) => {
      const file = disk.get(path);
      disk.set(path, {
        content: content ?? file?.content ?? "",
        mtime: ++clock,
      });
    },
    rename: (from: string, to: string) => {
      const file = disk.get(from);
      if (!file) throw new Error(`ENOENT ${from}`);
      disk.delete(from);
      disk.set(to, file);
    },
  };
}

function setup(
  files: Record<string, string>,
  autoSave = { enabled: false, delay: 500 },
) {
  const fs = createDisk(files);
  const host = {
    state: vi.fn<(doc: DocumentState) => void>(),
    dirty: vi.fn<(dirty: boolean) => void>(),
    saved: vi.fn<(path: string) => void>(),
    conflict: vi.fn<(path: string, overwrite: () => void) => void>(),
    released: vi.fn<(path: string) => void>(),
    autoSave: () => autoSave,
  };
  const session = new DocumentSession(fs.io, host);
  return {
    ...fs,
    host,
    session,
    doc: () => host.state.mock.lastCall?.[0],
    dirty: () => host.dirty.mock.lastCall?.[0] ?? false,
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("DocumentSession loading", () => {
  it("publishes the file as ready and clean", async () => {
    const t = setup({ "/p/a.ts": "one\r\ntwo\r\n" });
    t.session.open("/p/a.ts");
    expect(t.doc()).toEqual({ status: "loading" });
    await flush();
    expect(t.doc()).toEqual({
      status: "ready",
      content: "one\ntwo\n",
      size: 10,
    });
    expect(t.dirty()).toBe(false);
  });

  it("restores the file's line endings on save", async () => {
    const t = setup({ "/p/a.ts": "one\r\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("one\nmore\n");
    expect(await t.session.save()).toBe(true);
    expect(t.disk.get("/p/a.ts")?.content).toBe("one\r\nmore\r\n");
    expect(t.dirty()).toBe(false);
    expect(t.host.saved).toHaveBeenCalledWith("/p/a.ts");
  });

  it("drops a load that resolves after the pane closed", async () => {
    const t = setup({ "/p/a.ts": "one\n" });
    t.hold("read");
    t.session.open("/p/a.ts");
    t.session.close();
    t.release("read");
    await flush();
    expect(t.doc()).toEqual({ status: "loading" });
    expect(t.host.released).toHaveBeenCalledWith("/p/a.ts");
  });

  it("keeps the dirty flag current for a reload before the next render", async () => {
    const t = setup({ "/p/a.ts": "one\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("typed\n");
    expect(t.session.reload()).toBe(false);
  });
});

describe("DocumentSession rename (crynta/terax-ai#1369)", () => {
  it("keeps unsaved edits when the open file is renamed", async () => {
    const t = setup({ "/p/a.ts": "saved\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("unsaved\n");

    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    await flush();

    expect(t.log.filter((l) => l.startsWith("read"))).toEqual(["read /p/a.ts"]);
    expect(t.doc()).toEqual({ status: "ready", content: "saved\n", size: 6 });
    expect(t.dirty()).toBe(true);
    expect(t.host.released).toHaveBeenCalledWith("/p/a.ts");

    expect(await t.session.save()).toBe(true);
    expect(t.disk.get("/p/b.ts")?.content).toBe("unsaved\n");
    expect(t.disk.has("/p/a.ts")).toBe(false);
    expect(t.host.conflict).not.toHaveBeenCalled();
  });

  it("loads from disk on a path change that is not a rename", async () => {
    const t = setup({ "/p/a.ts": "a\n", "/p/b.ts": "b\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("edit\n");
    t.session.open("/p/b.ts");
    expect(t.dirty()).toBe(false);
    await flush();
    expect(t.doc()).toEqual({ status: "ready", content: "b\n", size: 2 });
    expect(await t.session.save()).toBe(true);
    expect(t.log).not.toContain("write /p/b.ts");
  });

  it("reads the new path when renamed mid-load and leaves no note behind", async () => {
    const t = setup({ "/p/a.ts": "a\n" });
    t.hold("read");
    t.session.open("/p/a.ts");
    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    t.release("read");
    await flush();
    expect(t.doc()).toEqual({ status: "ready", content: "a\n", size: 2 });
    expect(consumeRetarget("/p/a.ts", "/p/b.ts")).toBe(false);
  });

  it("re-arms a pending autosave onto the new path", async () => {
    vi.useFakeTimers();
    const t = setup({ "/p/a.ts": "a\n" }, { enabled: true, delay: 500 });
    t.session.open("/p/a.ts");
    await vi.advanceTimersByTimeAsync(0);
    t.session.change("edit\n");
    await vi.advanceTimersByTimeAsync(300);
    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    await vi.advanceTimersByTimeAsync(600);
    expect(t.log.filter((l) => l.startsWith("write"))).toEqual([
      "write /p/b.ts",
    ]);
    expect(t.disk.get("/p/b.ts")?.content).toBe("edit\n");
    expect(t.dirty()).toBe(false);
  });

  it("never writes the old path from a save started before the rename", async () => {
    const t = setup({ "/p/a.ts": "a\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("edit\n");
    t.hold("mtime");
    const saving = t.session.save();
    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    t.release("mtime");
    expect(await saving).toBe(false);
    expect(t.log.filter((l) => l.startsWith("write"))).toEqual([]);
    expect(t.dirty()).toBe(true);
  });

  it("keeps the buffer dirty when a write completes after the rename", async () => {
    const t = setup({ "/p/a.ts": "a\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("edit\n");
    t.hold("write");
    const saving = t.session.save();
    await flush();
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    t.release("write");
    expect(await saving).toBe(false);
    expect(t.dirty()).toBe(true);
    expect(t.host.saved).not.toHaveBeenCalled();
  });

  it("ignores an Overwrite from a notice raised before the rename", async () => {
    const t = setup({ "/p/a.ts": "a\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("mine\n");
    t.touch("/p/a.ts", "theirs\n");
    expect(await t.session.save()).toBe(false);
    const overwrite = t.host.conflict.mock.lastCall?.[1];
    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    overwrite?.();
    await flush();
    expect(t.log.filter((l) => l.startsWith("write"))).toEqual([]);
  });
});
