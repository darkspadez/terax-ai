import { readFile } from "node:fs/promises";
import { AdaptedGhosttyTerminalModel } from "@/modules/terminal/ghostty/AdaptedGhosttyTerminalModel";
import {
  decodeScrollbackFile,
  encodeScrollbackFile,
} from "@/modules/terminal/lib/terminalScrollback";
import {
  type PendingScrollbackRestore,
  type ScrollbackBackend,
  ScrollbackRestoreGate,
  TerminalScrollbackRegistry,
} from "@/modules/terminal/lib/terminalScrollbackRestore";
import { TeraxGhostty } from "@terax/ghostty-core/adapted";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const encoder = new TextEncoder();
const savedAt = Date.UTC(2026, 9, 22, 14, 3);
const marker = "─── Restored saved ───";

let core: TeraxGhostty;
const models: AdaptedGhosttyTerminalModel[] = [];

beforeAll(async () => {
  const file = await readFile(
    new URL(
      "../../../../packages/ghostty-core/adapted/ghostty-vt.wasm",
      import.meta.url,
    ),
  );
  core = await TeraxGhostty.loadBytes(Uint8Array.from(file).buffer);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const model of models.splice(0)) model.dispose();
});

function terminal(text = "", cols = 60, rows = 5) {
  const model = new AdaptedGhosttyTerminalModel(core, {
    backend: "ghostty-webgpu",
    cols,
    rows,
  });
  models.push(model);
  if (text) model.write(encoder.encode(text));
  return model;
}

function write(model: AdaptedGhosttyTerminalModel, text: string): void {
  model.write(encoder.encode(text));
}

function text(model: AdaptedGhosttyTerminalModel): string[] {
  return model.readText(10_000).split("\n");
}

function storage(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const backend = {
    load: vi.fn(async (key: string) => files.get(key) ?? ""),
    save: vi.fn(async (key: string, body: string) => {
      if (body) files.set(key, body);
      else files.delete(key);
    }),
    retain: vi.fn(async (keys: readonly string[]) => {
      let removed = 0;
      for (const key of [...files.keys()]) {
        if (keys.includes(key)) continue;
        files.delete(key);
        removed++;
      }
      return removed;
    }),
  } satisfies ScrollbackBackend;
  return { files, backend };
}

function saved(history: string): string {
  return encodeScrollbackFile(history, savedAt);
}

function registry(
  backend: ScrollbackBackend,
  panes: Map<number, AdaptedGhosttyTerminalModel> = new Map(),
) {
  let enabled = true;
  const listeners = new Set<() => void>();
  let next = 0;
  const instance = new TerminalScrollbackRegistry({
    backend,
    settings: {
      ready: async () => {},
      enabled: () => enabled,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    model: (leafId) => panes.get(leafId) ?? null,
    now: () => savedAt,
    newKey: () => `sb-new-${++next}`,
    formatDate: () => "saved",
  });
  return {
    instance,
    panes,
    setEnabled(value: boolean) {
      enabled = value;
      for (const listener of listeners) listener();
    },
  };
}

function history(file: string | undefined): string {
  return decodeScrollbackFile(file ?? "")?.vt ?? "";
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pending(result: Promise<string | null>): PendingScrollbackRestore & {
  release: Mock<() => void>;
} {
  let value: string | null | undefined;
  void result.then((settled) => {
    value = settled;
  });
  return { result, settled: () => value, release: vi.fn<() => void>() };
}

describe("scrollback keys", () => {
  it("adopts a restored pane's key once, and only a valid unused one", () => {
    const { instance } = registry(storage().backend);
    instance.adopt(10, "sb-a");
    instance.adopt(10, "sb-b");
    instance.adopt(11, "sb-a");
    instance.adopt(12, "../escape");
    instance.adopt(13, 42);
    expect(instance.keyForLeaf(10)).toBe("sb-a");
    expect(instance.keyForLeaf(11)).toBeUndefined();
    expect(instance.keyForLeaf(12)).toBeUndefined();
    expect(instance.keyForLeaf(13)).toBeUndefined();
  });

  it("gives live panes keys before they are serialized, never cold ones", async () => {
    const { files, backend } = storage({ "sb-cold": saved("cold history") });
    const { instance, panes } = registry(backend);
    panes.set(1, terminal("live history\r\n$ "));
    instance.adopt(2, "sb-cold");

    const saving = instance.persist([1, 2, 3]);
    expect(instance.keyForLeaf(1)).toBe("sb-new-1");
    expect(instance.keyForLeaf(2)).toBe("sb-cold");
    expect(instance.keyForLeaf(3)).toBeUndefined();
    await saving;

    expect(history(files.get("sb-new-1"))).toContain("live history");
    expect(files.get("sb-cold")).toBe(saved("cold history"));
    expect(backend.retain).toHaveBeenLastCalledWith(["sb-cold", "sb-new-1"]);
  });
});

describe("saving scrollback", () => {
  it("skips panes whose content has not changed since their last save", async () => {
    const { files, backend } = storage();
    const { instance, panes } = registry(backend);
    const model = terminal("first\r\n");
    panes.set(1, model);

    await instance.persist([1]);
    await instance.persist([1]);
    expect(backend.save).toHaveBeenCalledTimes(1);

    write(model, "second\r\n");
    await instance.persist([1]);
    expect(backend.save).toHaveBeenCalledTimes(2);
    expect(history(files.get("sb-new-1"))).toContain("second");
  });

  it("never saves private panes and sweeps the file of a pane that stops being listed", async () => {
    const { files, backend } = storage();
    const { instance, panes } = registry(backend);
    panes.set(1, terminal("kept\r\n"));
    panes.set(2, terminal("private secret\r\n"));
    panes.set(3, terminal("closed later\r\n"));

    await instance.persist([1, 3]);
    expect([...files.keys()].sort()).toEqual(["sb-new-1", "sb-new-2"]);
    expect([...files.values()].join()).not.toContain("private secret");
    expect(instance.keyForLeaf(2)).toBeUndefined();

    await instance.persist([1]);
    expect([...files.keys()]).toEqual(["sb-new-1"]);
    expect(instance.keyForLeaf(3)).toBeUndefined();
  });

  it("keeps restored panes' files until the restored tabs are listed", async () => {
    const { files, backend } = storage({ "sb-old": saved("old history") });
    const { instance } = registry(backend);
    instance.adopt(10, "sb-old");

    // A list taken before the restored tabs are in place.
    await instance.persist([2]);
    expect(files.has("sb-old")).toBe(true);

    await instance.persist([10]);
    await instance.persist([]);
    expect(files.has("sb-old")).toBe(false);
  });

  it("keeps the stored history while a full-screen program runs", async () => {
    const { files, backend } = storage();
    const { instance, panes } = registry(backend);
    const model = terminal("shell history\r\n");
    panes.set(1, model);
    await instance.persist([1]);

    write(model, "\x1b[?1049hfull screen");
    await instance.persist([1]);
    expect(history(files.get("sb-new-1"))).toContain("shell history");
    expect(history(files.get("sb-new-1"))).not.toContain("full screen");

    write(model, "\x1b[?1049lafter");
    await instance.persist([1]);
    expect(history(files.get("sb-new-1"))).toContain("after");
  });

  it("deletes the file of a pane that was cleared", async () => {
    const { files, backend } = storage();
    const { instance, panes } = registry(backend);
    const model = terminal("history\r\n");
    panes.set(1, model);
    await instance.persist([1]);
    expect(files.has("sb-new-1")).toBe(true);

    model.clear();
    write(model, "\x1b[3J");
    await instance.persist([1]);
    expect(files.has("sb-new-1")).toBe(false);
  });

  it("trims what it saves to the newest lines", async () => {
    const { files, backend } = storage();
    const panes = new Map([[1, terminal("", 20, 4)]]);
    let body = "";
    for (let line = 0; line < 6_000; line++) body += `line ${line}\r\n`;
    write(panes.get(1) as AdaptedGhosttyTerminalModel, body);
    const { instance } = registry(backend, panes);
    await instance.persist([1]);
    const lines = history(files.get("sb-new-1")).split("\r\n");
    expect(lines.length).toBeLessThanOrEqual(5_000);
    expect(lines[lines.length - 1]).toContain("line 5999");
    expect(lines[0]).toMatch(/^line \d+/);
  });

  it("turning the setting off deletes every file and stops saving", async () => {
    const { files, backend } = storage({ "sb-cold": saved("cold") });
    const { instance, panes, setEnabled } = registry(backend);
    const model = terminal("history\r\n");
    panes.set(1, model);
    instance.adopt(2, "sb-cold");
    const detach = instance.attachLeafSource(() => [1, 2]);
    await instance.persist([1, 2]);
    expect(files.size).toBe(2);

    setEnabled(false);
    await instance.persist([1, 2]);
    expect(files.size).toBe(0);
    expect(backend.retain).toHaveBeenCalledWith([]);
    write(model, "more\r\n");
    await instance.persist([1, 2]);
    expect(files.size).toBe(0);
    expect(backend.retain).toHaveBeenCalledTimes(2);

    setEnabled(true);
    await instance.persist([1, 2]);
    expect(history(files.get("sb-new-1"))).toContain("more");
    detach();
  });

  it("logs and carries on when a save fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { files, backend } = storage();
    backend.save.mockRejectedValueOnce(new Error("disk full"));
    const { instance, panes } = registry(backend);
    panes.set(1, terminal("one\r\n"));
    panes.set(2, terminal("two\r\n"));
    await instance.persist([1, 2]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect([...files.keys()]).toEqual(["sb-new-2"]);
    await instance.persist([1, 2]);
    expect([...files.keys()].sort()).toEqual(["sb-new-1", "sb-new-2"]);
  });
});

describe("restoring scrollback", () => {
  it("restores a saved pane into the new launch's pane, once", async () => {
    const { backend } = storage();
    const before = registry(backend);
    before.panes.set(1, terminal("\x1b[32mbuilt ok\x1b[0m\r\n$ make\r\n$ "));
    await before.instance.persist([1]);

    const after = registry(backend);
    after.instance.adopt(40, "sb-new-1");
    const restore = after.instance.takeRestore(40);
    expect(after.instance.takeRestore(40)).toBeNull();
    const model = terminal();
    const gate = new ScrollbackRestoreGate(restore);
    await restore?.result;
    gate.connect((bytes) => model.write(bytes));
    gate.write(encoder.encode("$ "));

    expect(text(model)).toEqual(["built ok", "$ make", "$", marker, "$"]);
  });

  it("restores nothing when the setting is off, the file is missing or unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend } = storage({ "sb-a": saved("a"), "sb-b": "garbage" });
    const { instance, setEnabled } = registry(backend);
    instance.adopt(1, "sb-a");
    instance.adopt(2, "sb-b");
    instance.adopt(3, "sb-missing");
    instance.adopt(4, "sb-failing");
    backend.load.mockImplementation(async (key: string) => {
      if (key === "sb-failing") throw new Error("io");
      return key === "sb-b" ? "garbage" : key === "sb-a" ? saved("a") : "";
    });

    await expect(instance.takeRestore(2)?.result).resolves.toBeNull();
    await expect(instance.takeRestore(3)?.result).resolves.toBeNull();
    await expect(instance.takeRestore(4)?.result).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    setEnabled(false);
    await expect(instance.takeRestore(1)?.result).resolves.toBeNull();
    expect(instance.takeRestore(5)).toBeNull();
  });

  it("never saves a pane before its restore is in the model", async () => {
    const { files, backend } = storage({ "sb-old": saved("old history") });
    const load = deferred<string>();
    backend.load.mockReturnValueOnce(load.promise);
    const { instance, panes } = registry(backend);
    instance.adopt(1, "sb-old");
    const restore = instance.takeRestore(1);
    const model = terminal();
    panes.set(1, model);
    const gate = new ScrollbackRestoreGate(restore);
    gate.connect((bytes) => model.write(bytes));
    gate.write(encoder.encode("$ "));

    await instance.persist([1]);
    expect(files.get("sb-old")).toBe(saved("old history"));

    load.resolve(saved("old history"));
    await restore?.result;
    await instance.persist([1]);
    expect(history(files.get("sb-old"))).toContain("old history");
    expect(history(files.get("sb-old"))).toContain(marker);
  });
});

describe("ScrollbackRestoreGate", () => {
  it("holds shell output that arrives while history loads and writes it after", async () => {
    const load = deferred<string | null>();
    const restore = pending(load.promise);
    const model = terminal();
    const gate = new ScrollbackRestoreGate(restore);
    gate.connect((bytes) => model.write(bytes));

    gate.write(encoder.encode("welcome\r\n"));
    gate.write(encoder.encode("$ "));
    expect(model.readText(10)).toBe("");
    expect(restore.release).not.toHaveBeenCalled();

    load.resolve(`old 1\r\nold 2\x1b[0m\r\n\x1b[2m${marker}\x1b[0m\r\n`);
    await load.promise;
    expect(text(model)).toEqual(["old 1", "old 2", marker, "welcome", "$"]);
    expect(restore.release).toHaveBeenCalledTimes(1);

    gate.write(encoder.encode("ls"));
    expect(text(model).pop()).toBe("$ ls");
  });

  it("writes a restore that already settled as soon as it is connected", async () => {
    const restore = pending(Promise.resolve("restored\r\n"));
    await restore.result;
    const model = terminal();
    const gate = new ScrollbackRestoreGate(restore);
    expect(restore.release).toHaveBeenCalledTimes(1);
    gate.connect((bytes) => model.write(bytes));
    expect(model.readText(10)).toBe("restored");
  });

  it("gives a slow restore up after the wait, keeping the shell's output", async () => {
    vi.useFakeTimers();
    const load = deferred<string | null>();
    const restore = pending(load.promise);
    const model = terminal();
    const gate = new ScrollbackRestoreGate(restore, {
      waitMs: 2_000,
      holdBytes: 1024,
    });
    gate.connect((bytes) => model.write(bytes));
    gate.write(encoder.encode("$ "));

    await vi.advanceTimersByTimeAsync(1_999);
    expect(model.readText(10)).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(model.readText(10)).toBe("$");
    expect(restore.release).toHaveBeenCalledTimes(1);

    load.resolve("too late\r\n");
    await load.promise;
    gate.write(encoder.encode("ls"));
    expect(model.readText(10)).toBe("$ ls");
  });

  it("gives the restore up when the held output outgrows its bound", () => {
    const restore = pending(new Promise(() => {}));
    const model = terminal();
    const gate = new ScrollbackRestoreGate(restore, {
      waitMs: 60_000,
      holdBytes: 8,
    });
    gate.connect((bytes) => model.write(bytes));
    gate.write(encoder.encode("1234"));
    expect(model.readText(10)).toBe("");
    gate.write(encoder.encode("56789"));
    expect(model.readText(10)).toBe("123456789");
    expect(restore.release).toHaveBeenCalledTimes(1);
  });

  it("passes output straight through when there is nothing to restore", () => {
    const model = terminal();
    const gate = new ScrollbackRestoreGate(null);
    gate.connect((bytes) => model.write(bytes));
    gate.write(encoder.encode("$ "));
    expect(model.readText(10)).toBe("$");
  });
});

describe("close-time flush", () => {
  it("does nothing until the restored tabs are attached", async () => {
    const { backend } = storage({ "sb-a": saved("a") });
    const { instance } = registry(backend);
    await expect(instance.flush(1_000)).resolves.toEqual({ timedOut: false });
    expect(backend.retain).not.toHaveBeenCalled();
    expect(backend.save).not.toHaveBeenCalled();
  });

  it("saves panes that have keys without creating new ones", async () => {
    const { files, backend } = storage();
    const { instance, panes } = registry(backend);
    const model = terminal("before\r\n");
    panes.set(1, model);
    panes.set(2, terminal("never keyed\r\n"));
    await instance.persist([1]);
    instance.attachLeafSource(() => [1, 2]);
    write(model, "at close\r\n");

    await expect(instance.flush(1_000)).resolves.toEqual({ timedOut: false });
    expect(history(files.get("sb-new-1"))).toContain("at close");
    expect(instance.keyForLeaf(2)).toBeUndefined();
  });

  it("never waits past its timeout", async () => {
    vi.useFakeTimers();
    const { backend } = storage();
    backend.save.mockReturnValue(new Promise(() => {}));
    const { instance, panes } = registry(backend);
    panes.set(1, terminal("history\r\n"));
    void instance.persist([1]);
    instance.attachLeafSource(() => [1]);

    let result: { timedOut: boolean } | null = null;
    void instance.flush(1_500).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ timedOut: true });
  });
});
