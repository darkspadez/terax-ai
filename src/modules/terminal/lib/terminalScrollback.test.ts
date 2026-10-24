import { readFile } from "node:fs/promises";
import { AdaptedGhosttyTerminalModel } from "@/modules/terminal/ghostty/AdaptedGhosttyTerminalModel";
import {
  createScrollbackKey,
  decodeScrollbackFile,
  encodeScrollbackFile,
  exportScrollback,
  hasVisibleText,
  isScrollbackKey,
  restoreSequence,
  sanitizeScrollback,
  trimScrollback,
} from "@/modules/terminal/lib/terminalScrollback";
import { OarlockGhostty } from "@oarlock/ghostty-core/adapted";
import { beforeAll, describe, expect, it } from "vitest";

const encoder = new TextEncoder();
const savedAt = Date.UTC(2026, 9, 22, 14, 3);
const formatDate = (at: number) => new Date(at).toISOString();

let core: OarlockGhostty;

beforeAll(async () => {
  const file = await readFile(
    new URL(
      "../../../../packages/ghostty-core/adapted/ghostty-vt.wasm",
      import.meta.url,
    ),
  );
  core = await OarlockGhostty.loadBytes(Uint8Array.from(file).buffer);
});

function terminal(cols = 40, rows = 6) {
  const replies: Uint8Array[] = [];
  const model = new AdaptedGhosttyTerminalModel(core, {
    backend: "ghostty-webgpu",
    cols,
    rows,
    onReply: (bytes) => replies.push(bytes),
  });
  return {
    model,
    replies,
    write: (text: string) => model.write(encoder.encode(text)),
    lines: () => model.readText(10_000).split("\n"),
  };
}

function numbered(count: number, from = 0): string {
  let out = "";
  for (let line = from; line < from + count; line++) out += `line ${line}\r\n`;
  return out;
}

describe("scrollback keys", () => {
  it("are short random identifiers the native side accepts", () => {
    const key = createScrollbackKey(1_700_000_000_000);
    expect(key).toMatch(/^sb-[0-9a-z]+-[0-9a-f]{16}$/);
    expect(isScrollbackKey(key)).toBe(true);
    expect(createScrollbackKey(1_700_000_000_000)).not.toBe(key);
    expect(createScrollbackKey(36, () => "x")).toBe("sb-10-x");
    for (const bad of ["", "../x", "a.vt", "a b", "é", "k".repeat(129), 7]) {
      expect(isScrollbackKey(bad)).toBe(false);
    }
  });
});

describe("trimScrollback", () => {
  it("keeps the newest whole lines within the line limit", () => {
    expect(
      trimScrollback("a\r\nb\r\nc\r\nd", { maxLines: 2, maxBytes: 100 }),
    ).toBe("c\r\nd");
    expect(trimScrollback("a\r\n\r\nb", { maxLines: 5, maxBytes: 100 })).toBe(
      "a\r\n\r\nb",
    );
    expect(trimScrollback("a\r\nb", { maxLines: 0, maxBytes: 100 })).toBe("");
  });

  it("drops the oldest lines on a line boundary to fit the byte limit", () => {
    // "é" is two UTF-8 bytes, "日" three and the emoji four.
    const vt = ["\x1b[31mé\x1b[0m", "日本", "🎉", "ok"].join("\r\n");
    const all = encoder.encode(vt).byteLength;
    expect(trimScrollback(vt, { maxLines: 10, maxBytes: all })).toBe(vt);
    const kept = trimScrollback(vt, { maxLines: 10, maxBytes: all - 1 });
    expect(kept).toBe("日本\r\n🎉\r\nok");
    expect(
      trimScrollback(vt, {
        maxLines: 10,
        maxBytes: encoder.encode(kept).byteLength - 1,
      }),
    ).toBe("🎉\r\nok");
    expect(trimScrollback(vt, { maxLines: 10, maxBytes: 1 })).toBe("");
  });
});

describe("exportScrollback", () => {
  it("exports styled history and the screen, newest last", () => {
    const { model, write } = terminal();
    try {
      write(`\x1b[31mred\x1b[0m plain\r\n${numbered(12)}$ `);
      const vt = exportScrollback(model);
      expect(vt).not.toBeNull();
      expect(vt).toContain("\x1b[38;5;1mred");
      expect(vt?.split("\r\n")).toHaveLength(14);
      expect(vt?.split("\r\n")[13]).toContain("$");
    } finally {
      model.dispose();
    }
  });

  it("caps the line count from the oldest end without a partial first line", () => {
    const { model, write } = terminal(10, 4);
    try {
      // The first exported row is the tail of a soft-wrapped line.
      write(`${numbered(20)}0123456789abcdefghij\r\nlast`);
      const limits = { maxBytes: 1 << 20 };
      const vt = exportScrollback(model, { ...limits, maxLines: 5 });
      expect(vt?.split("\r\n")).toEqual(
        ["line 19", "0123456789abcdefghij", "last"].map((line) =>
          expect.stringContaining(line),
        ),
      );
      // Two rows start inside the wrapped line: its tail is not kept alone.
      const tail = exportScrollback(model, { ...limits, maxLines: 2 });
      expect(tail).not.toContain("abcdefghij");
      expect(tail).toContain("last");
    } finally {
      model.dispose();
    }
  });

  it("keeps the stored history while a full-screen program runs", () => {
    const { model, write } = terminal();
    try {
      write("history\r\n\x1b[?1049hvim");
      expect(exportScrollback(model)).toBeNull();
      write("\x1b[?1049l");
      expect(exportScrollback(model)).toContain("history");
    } finally {
      model.dispose();
    }
  });

  it("has nothing to keep for an empty or blank pane", () => {
    const { model, write } = terminal();
    try {
      expect(exportScrollback(model)).toBe("");
      write("\x1b[44m   \x1b[0m\r\n\r\n");
      expect(exportScrollback(model)).toBe("");
      expect(hasVisibleText("\x1b[0m \x1b[1m\r\n")).toBe(false);
    } finally {
      model.dispose();
    }
  });

  it("reads in chunks that join back to exactly what one read gives", () => {
    const { model, write } = terminal(10, 4);
    const whole = terminal(80, 4);
    const chunked = terminal(80, 4);
    try {
      write(
        [
          "\x1b[31mred line that wraps twice over\r\n",
          "\r\n\r\n",
          "\x1b[42mstill styled\x1b[0m\r\n",
          "  indented\r\n",
          `${numbered(9)}`,
          "\x1b[1mbold and long enough to wrap\x1b[0m\r\n",
          "$ ",
        ].join(""),
      );
      const limits = { maxLines: 1_000, maxBytes: 1 << 20 };
      const one = exportScrollback(model, limits, 1_000_000) ?? "";
      whole.write(one);
      for (const rows of [1, 2, 3, 5]) {
        const parts = exportScrollback(model, limits, rows) ?? "";
        const replay = terminal(80, 4);
        try {
          replay.write(parts);
          expect(replay.lines()).toEqual(whole.lines());
          const total = replay.model.scrollPosition().history + 4;
          expect(replay.model.formatTextRange(0, total - 1, "vt")).toBe(
            whole.model.formatTextRange(0, total - 1, "vt"),
          );
        } finally {
          replay.model.dispose();
        }
      }
      chunked.write(exportScrollback(model, limits, 3) ?? "");
      expect(chunked.lines()[0]).toBe("red line that wraps twice over");
    } finally {
      model.dispose();
      whole.model.dispose();
      chunked.model.dispose();
    }
  });

  it("gives older history up rather than cut a line it cannot split", () => {
    const { model, write } = terminal(10, 4);
    try {
      // A hundred rows of one logical line: more than a split search covers.
      write(`old\r\n${"A".repeat(1_000)}\r\nnew 1\r\nnew 2`);
      const limits = { maxLines: 1_000, maxBytes: 1 << 20 };
      const vt = exportScrollback(model, limits, 3) ?? "";
      expect(vt.replace(/\x1b\[[0-9;]*m/g, "")).toBe("new 1\r\nnew 2");
      expect(exportScrollback(model, limits, 1_000)).toContain(
        `old\r\n${"A".repeat(1_000)}`,
      );
    } finally {
      model.dispose();
    }
  });

  it("does not grow the pane's memory by the size of what it exports", () => {
    const { model, write } = terminal(120, 40);
    try {
      let text = "";
      for (let line = 0; line < 6_000; line++) {
        text += `\x1b[32mline\x1b[0m ${line} \x1b[1;34m${"x".repeat(40)}\x1b[0m \x1b[33m${"y".repeat(30)}\x1b[0m\r\n`;
      }
      write(text);
      const memory = () => model.consumeGpuFrame().memory.buffer.byteLength;
      const before = memory();
      const vt = exportScrollback(model) ?? "";
      expect(vt.split("\r\n").length).toBeGreaterThan(4_990);
      expect(memory() - before).toBeLessThan(vt.length / 2);
    } finally {
      model.dispose();
    }
  });
});

describe("scrollback files", () => {
  it("round-trips the save time and history", () => {
    const file = encodeScrollbackFile("a\r\nb", savedAt);
    expect(decodeScrollbackFile(file)).toEqual({ savedAt, vt: "a\r\nb" });
  });

  it("rejects files that are not a saved history", () => {
    for (const bad of [
      "",
      "a\r\nb",
      "oarlock-scrollback 1 x\nhistory",
      "oarlock-scrollback 2 1\nhistory",
      "oarlock-scrollback 1 99999999999999999\nhistory",
      "\0\0\0\0",
    ]) {
      expect(decodeScrollbackFile(bad)).toBeNull();
      expect(restoreSequence(bad, formatDate)).toBeNull();
    }
  });
});

describe("sanitizeScrollback", () => {
  it("keeps text, line breaks and SGR styles only", () => {
    expect(
      sanitizeScrollback(
        "\x1b[0m\x1b[38;2;1;2;3;1mok\x1b[0m\r\nnext\nbare\rcr\ttab\x07",
      ),
    ).toBe("\x1b[0m\x1b[38;2;1;2;3;1mok\x1b[0m\r\nnext\r\nbarecrtab");
  });

  it("removes everything that could act on the terminal or the shell", () => {
    const sequences = [
      "\x1b]52;c;cm0gLXJmIH4K\x07", // clipboard write
      "\x1b]7;file:///etc\x1b\\", // cwd
      "\x1b]0;title\x07", // title
      "\x1b]8;;https://x\x1b\\", // hyperlink
      "\x1b[6n", // cursor position report: an answer becomes shell input
      "\x1b[c", // device attributes
      "\x1bP$qm\x1b\\", // DECRQSS
      "\x1b[?1049h", // alternate screen
      "\x1b[2J\x1b[3J", // erase
      "\x1b[10;10H", // cursor movement
      "\x1b7\x1b8\x1bc", // save, restore, reset
      "\x9b6n", // 8-bit CSI
      "\x1b_apc\x1b\\\x1b^pm\x1b\\\x1bXsos\x1b\\",
      "\x1b]133;A\x07", // prompt marks
    ];
    const clean = sanitizeScrollback(
      `${sequences.join("visible")}\x1b]52;c;unterminated`,
    );
    // Only the 8-bit introducer goes; its parameters are inert text.
    const left = sequences.map((sequence) =>
      sequence.startsWith("\x9b") ? sequence.slice(1) : "",
    );
    expect(clean).toBe(left.join("visible"));
    expect(clean).not.toMatch(/[\x00-\x09\x0b-\x0c\x0e-\x1f\x7f-\x9f]/);
  });

  it("makes a hostile file harmless to a live terminal", () => {
    const { model, replies, write } = terminal();
    try {
      const file = encodeScrollbackFile(
        "\x1b[6n\x1b[c\x1b[>c\x1bP$qm\x1b\\\x1b]10;?\x07\x1b[?2048h\x1b[?1049hok",
        savedAt,
      );
      write(restoreSequence(file, formatDate) ?? "");
      expect(replies).toEqual([]);
      expect(model.modes().alternateScreen).toBe(false);
      expect(model.readText(10)).toContain("ok");
    } finally {
      model.dispose();
    }
  });
});

describe("restoreSequence", () => {
  it("replays history with a dim marker and leaves a clean line for the prompt", () => {
    const source = terminal(60, 5);
    const target = terminal(60, 5);
    try {
      source.write(`\x1b[1;32mgreen bold\x1b[0m\r\n${numbered(8)}$ ls\x1b[31m`);
      const vt = exportScrollback(source.model) ?? "";
      const sequence = restoreSequence(
        encodeScrollbackFile(vt, savedAt),
        formatDate,
      );
      expect(sequence).not.toBeNull();
      expect(sequence).toContain(
        `\x1b[0m\r\n\x1b[2m─── Restored ${formatDate(savedAt)} ───\x1b[0m\r\n`,
      );
      target.write(sequence ?? "");
      target.write("new prompt$ ");
      const lines = target.lines();
      expect(lines[0]).toBe("green bold");
      expect(lines.slice(-3)).toEqual([
        "$ ls",
        `─── Restored ${formatDate(savedAt)} ───`,
        "new prompt$",
      ]);
      expect(target.model.cursor().x).toBe("new prompt$ ".length);
      // The restored red pen does not leak into the new shell's output.
      expect(
        target.model.formatTextRange(
          target.model.scrollPosition().history + target.model.cursor().y,
          target.model.scrollPosition().history + target.model.cursor().y,
          "vt",
        ),
      ).not.toContain("38;5;1");
    } finally {
      source.model.dispose();
      target.model.dispose();
    }
  });

  it("has nothing to restore from an empty history", () => {
    expect(restoreSequence(encodeScrollbackFile("", savedAt), formatDate)).toBe(
      null,
    );
    expect(
      restoreSequence(
        encodeScrollbackFile("\x1b[0m\r\n ", savedAt),
        formatDate,
      ),
    ).toBeNull();
  });

  it("applies the limits to what it reads back", () => {
    const sequence = restoreSequence(
      encodeScrollbackFile("one\r\ntwo\r\nthree", savedAt),
      formatDate,
      { maxLines: 2, maxBytes: 1024 },
    );
    expect(sequence?.startsWith("two\r\nthree\x1b[0m")).toBe(true);
  });
});
