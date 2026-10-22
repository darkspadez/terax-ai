import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { Mods } from "@terax/ghostty-core";
import {
  type TeraxGhosttyTerminal,
  TeraxGhostty,
} from "@terax/ghostty-core/adapted";
import { beforeAll, describe, expect, it } from "vitest";

// Protocols the Terax core answers or reports beyond plain VT parsing: Kitty
// graphics, in-band size reports, colour scheme and visibility reports,
// mouse encoding, progress / pointer / clipboard-read events, Kitty
// clipboard and drag and drop, and VT export.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(encoder.encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(
    8 + data.byteLength,
    crc32(chunk.subarray(4, 8 + data.byteLength)),
  );
  return chunk;
}

/** An 8-bit RGBA PNG (colour type 6), each row with filter type 0. */
function rgbaPng(
  width: number,
  height: number,
  pixels: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let row = 0; row < height; row += 1) {
    raw.set(
      pixels.subarray(row * width * 4, (row + 1) * width * 4),
      row * (1 + width * 4) + 1,
    );
  }
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.byteLength;
  }
  return png;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** `length` bytes of a repeating, not merely constant, pattern. */
function patterned(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31) % 251;
  return bytes;
}

describe.each([
  ["SIMD", "ghostty-vt.wasm"],
  ["scalar", "ghostty-vt-scalar.wasm"],
])("%s Ghostty core protocols", (_kind, artifact) => {
  let ghostty: TeraxGhostty;

  beforeAll(async () => {
    const file = await readFile(
      new URL(
        `../../../../packages/ghostty-core/adapted/${artifact}`,
        import.meta.url,
      ),
    );
    ghostty = await TeraxGhostty.loadBytes(Uint8Array.from(file).buffer);
  });

  function withTerminal(
    cols: number,
    rows: number,
    run: (
      terminal: TeraxGhosttyTerminal,
      write: (text: string) => string,
    ) => void,
  ): void {
    const terminal = ghostty.createTerminal(cols, rows);
    const write = (text: string): string => {
      terminal.write(encoder.encode(text));
      return decoder.decode(terminal.drainOutputBytes());
    };
    try {
      run(terminal, write);
    } finally {
      terminal.dispose();
    }
  }

  describe("Kitty graphics", () => {
    it("answers capability queries and accepts direct RGB and PNG transmissions", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setPixelSize(800, 480);
        expect(write("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\")).toBe(
          "\x1b_Gi=31;OK\x1b\\",
        );
        const pixels = Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 128]);
        expect(
          write(`\x1b_Gi=7,a=T,f=100;${base64(rgbaPng(2, 1, pixels))}\x1b\\`),
        ).toBe("\x1b_Gi=7;OK\x1b\\");
        terminal.updateRenderState();
        const [placement] = terminal.kittyPlacements();
        expect(placement).toMatchObject({
          imageId: 7,
          channels: 4,
          imageWidth: 2,
          imageHeight: 1,
          col: 0,
          row: 0,
          width: 2,
          height: 1,
          sourceWidth: 2,
          sourceHeight: 1,
        });
        expect([...placement.pixels]).toEqual([...pixels]);
        expect(placement.generation).toBeGreaterThan(0);
      });
    });

    it("refuses file media, which a webview cannot read", () => {
      withTerminal(80, 24, (_terminal, write) => {
        const path = base64(encoder.encode("/etc/hostname"));
        expect(write(`\x1b_Gi=3,a=T,t=f,f=24,s=1,v=1;${path}\x1b\\`)).toMatch(
          /^\x1b_Gi=3;E[A-Z]+:/,
        );
      });
    });

    it("places images by cell, keeps z order and forgets deleted images", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setPixelSize(800, 480);
        const red = base64(Uint8Array.from([255, 0, 0]));
        write(
          `\x1b[3;5H\x1b_Gi=1,a=T,f=24,s=1,v=1,c=2,r=1,z=-1,q=2;${red}\x1b\\`,
        );
        write(`\x1b[1;1H\x1b_Gi=2,a=T,f=24,s=1,v=1,z=5,q=2;${red}\x1b\\`);
        terminal.updateRenderState();
        expect(
          terminal
            .kittyPlacements()
            .map(({ imageId, channels, col, row, z, width, height }) => ({
              imageId,
              channels,
              col,
              row,
              z,
              width,
              height,
            })),
        ).toEqual([
          {
            imageId: 1,
            channels: 3,
            col: 4,
            row: 2,
            z: -1,
            width: 20,
            height: 20,
          },
          {
            imageId: 2,
            channels: 3,
            col: 0,
            row: 0,
            z: 5,
            width: 1,
            height: 1,
          },
        ]);
        expect(terminal.kittyBackgroundZLimit).toBe(-1_073_741_824);

        write("\x1b_Ga=d,d=I,i=1,q=2\x1b\\");
        terminal.updateRenderState();
        expect(terminal.kittyPlacements().map((p) => p.imageId)).toEqual([2]);
        expect(terminal.kittyAnimationTick(1_000)).toBeNull();
      });
    });

    it("draws virtual placements through Unicode placeholder cells", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setPixelSize(800, 480);
        const pixels = base64(new Uint8Array(4 * 4 * 3));
        write(`\x1b_Gi=9,a=T,U=1,f=24,s=4,v=4,c=2,r=1,q=2;${pixels}\x1b\\`);
        // Foreground colour 9 carries the image id; diacritics give row/column.
        write("\x1b[38;5;9m\u{10EEEE}̅̅\u{10EEEE}̅̍\x1b[0m");
        terminal.updateRenderState();
        // A run of placeholder cells is one placement over those cells.
        expect(terminal.kittyPlacements()).toMatchObject([
          {
            imageId: 9,
            z: -1,
            col: 0,
            row: 0,
            width: 20,
            height: 20,
            sourceWidth: 4,
          },
        ]);
      });
    });

    it("disables the protocol at a zero storage limit", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setImageStorageLimit(0);
        expect(write("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\")).not.toBe(
          "\x1b_Gi=31;OK\x1b\\",
        );
      });
    });
  });

  describe("size, colour scheme and visibility reports", () => {
    it("sends one mode 2048 report per resize with the current cell size", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setPixelSize(800, 480);
        expect(terminal.drainOutputBytes()).toHaveLength(0);
        expect(write("\x1b[?2048h")).toBe("\x1b[48;24;80;480;800t");

        terminal.resize(100, 30);
        expect(decoder.decode(terminal.drainOutputBytes())).toBe(
          "\x1b[48;30;100;600;1000t",
        );
        // The host confirms the pixel size of the new grid: no news.
        terminal.setPixelSize(1000, 600);
        expect(terminal.drainOutputBytes()).toHaveLength(0);
        // A font or scale change alters the cell size.
        terminal.setPixelSize(1200, 720);
        expect(decoder.decode(terminal.drainOutputBytes())).toBe(
          "\x1b[48;30;100;720;1200t",
        );

        write("\x1b[?2048l");
        terminal.resize(80, 24);
        expect(terminal.drainOutputBytes()).toHaveLength(0);
      });
    });

    it("keeps grapheme clustering (mode 2027) on, across a full reset", () => {
      withTerminal(80, 24, (_terminal, write) => {
        expect(write("\x1b[?2027$p")).toBe("\x1b[?2027;1$y");
        write("\x1bc");
        expect(write("\x1b[?2027$p")).toBe("\x1b[?2027;1$y");
      });
    });

    it("identifies as Terax and accepts the host's version", () => {
      withTerminal(80, 24, (terminal, write) => {
        expect(write("\x1b[>q")).toBe("\x1bP>|terax\x1b\\");
        terminal.setXtversion("terax 1.2.3");
        expect(write("\x1b[>q")).toBe("\x1bP>|terax 1.2.3\x1b\\");
        expect(() => terminal.setXtversion("bad\x1bversion")).toThrow(
          RangeError,
        );
        expect(() => terminal.setXtversion("")).toThrow(RangeError);
      });
    });

    it("answers DSR 996 with the host scheme and reports changes under mode 2031", () => {
      withTerminal(80, 24, (terminal, write) => {
        expect(write("\x1b[?996n")).toBe("\x1b[?997;1n");
        terminal.setColorScheme("light");
        expect(terminal.drainOutputBytes()).toHaveLength(0);
        expect(write("\x1b[?996n")).toBe("\x1b[?997;2n");

        write("\x1b[?2031h");
        terminal.setColorScheme("light");
        expect(terminal.drainOutputBytes()).toHaveLength(0);
        terminal.setColorScheme("dark");
        expect(decoder.decode(terminal.drainOutputBytes())).toBe(
          "\x1b[?997;1n",
        );
      });
    });

    it("reports visibility on request and on change under mode 2033", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setVisible(false);
        expect(write("\x1b[?998n")).toBe("\x1b[?999;2n");
        expect(write("\x1b[?2033h")).toBe("\x1b[?999;2n");
        terminal.setVisible(true);
        expect(decoder.decode(terminal.drainOutputBytes())).toBe(
          "\x1b[?999;1n",
        );
      });
    });

    it("answers each colour query once, including Kitty's OSC 21", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setDefaultColors(0xcdd6f4, 0x11111b, 0xf9e2af);
        expect(write("\x1b]10;?\x1b\\\x1b]4;1;?\x07")).toBe(
          "\x1b]10;rgb:cdcd/d6d6/f4f4\x1b\\\x1b]4;1;rgb:cccc/6666/6666\x07",
        );
        expect(write("\x1b]21;foreground=?\x1b\\")).toBe(
          "\x1b]21;foreground=rgb:cd/d6/f4\x1b\\",
        );
      });
    });
  });

  describe("events", () => {
    it("reports OSC 9;4 progress and its removal by a reset", () => {
      withTerminal(80, 24, (terminal, write) => {
        write("\x1b]9;4;1;42\x07\x1b]9;4;3\x07\x1b]9;4;0\x07\x1b]9;4;0\x07");
        expect(terminal.drainEvents()).toEqual([
          { type: "progress", state: "set", progress: 42 },
          { type: "progress", state: "indeterminate", progress: null },
          { type: "progress", state: "remove", progress: null },
        ]);
        write("\x1bc\x1b]9;4;2;7\x07\x1bc");
        expect(terminal.drainEvents()).toEqual([
          { type: "progress", state: "error", progress: 7 },
          { type: "progress", state: "remove", progress: null },
        ]);
      });
    });

    it("reports pointer shapes and their reset", () => {
      withTerminal(80, 24, (terminal, write) => {
        write("\x1b]22;pointer\x07\x1b]22;pointer\x07\x1b]22;crosshair\x1b\\");
        expect(terminal.drainEvents()).toEqual([
          { type: "pointer-shape", shape: "pointer" },
          { type: "pointer-shape", shape: "crosshair" },
        ]);
        write("\x1b]2;job\x07\x1bc");
        expect(terminal.drainEvents()).toEqual([
          { type: "title", title: "job" },
          { type: "title", title: "" },
          { type: "pointer-shape", shape: "text" },
        ]);
      });
    });

    it("turns OSC 52 reads into requests and keeps writes as writes", () => {
      withTerminal(80, 24, (terminal, write) => {
        expect(write("\x1b]52;c;?\x07\x1b]52;p;?\x1b\\")).toBe("");
        write(`\x1b]52;c;${base64(encoder.encode("hi"))}\x07`);
        expect(terminal.drainEvents()).toEqual([
          { type: "clipboard-read", selection: "c", terminator: "bel" },
          { type: "clipboard-read", selection: "p", terminator: "st" },
          { type: "clipboard", selection: "c", data: "aGk=" },
        ]);
        // Writes of megabytes arrive whole, up to what one OSC holds.
        const text = base64(patterned(5 * 1024 * 1024));
        write(`\x1b]52;c;${text}\x07`);
        const [event] = terminal.drainEvents();
        expect(event?.type === "clipboard" && event.data === text).toBe(true);
      });
    });
  });

  describe("Kitty clipboard (OSC 5522)", () => {
    const b64 = (text: string) => base64(encoder.encode(text));
    const kittyWrite = (mime: string | null, data = "") =>
      "\x1b]5522;type=write\x1b\\" +
      (mime === null
        ? ""
        : `\x1b]5522;type=wdata:mime=${b64(mime)};${b64(data)}\x1b\\`) +
      "\x1b]5522;type=wdata\x1b\\";

    it("refuses reads and writes until the host takes them", () => {
      withTerminal(80, 24, (terminal, write) => {
        expect(write(`\x1b]5522;type=read;${b64("text/plain")}\x1b\\`)).toBe(
          "\x1b]5522;type=read:status=EPERM\x1b\\",
        );
        expect(write(kittyWrite("text/plain", "hi"))).toBe(
          "\x1b]5522;type=write:status=EPERM\x1b\\",
        );
        expect(terminal.drainEvents()).toEqual([]);
      });
    });

    it("holds a read for the host and replays its answer through Ghostty", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setClipboardPolicy({ readsToHost: true, writesAllowed: false });
        // Nothing answers the program until the host does.
        expect(
          write(`\x1b]5522;type=read:name=${b64("vim")};${b64("text/plain .")}\x07`),
        ).toBe("");
        expect(terminal.drainEvents()).toEqual([
          {
            type: "kitty-clipboard-read",
            id: 1,
            primary: false,
            list: true,
            granted: false,
            name: "vim",
            mimes: ["text/plain"],
          },
        ]);
        expect(
          terminal.answerKittyClipboardRead(1, {
            status: "success",
            available: ["text/plain"],
            contents: [{ mime: "text/plain", data: encoder.encode("hello") }],
          }),
        ).toBe(true);
        expect(decoder.decode(terminal.drainOutputBytes())).toBe(
          "\x1b]5522;type=read:status=OK\x07" +
            `\x1b]5522;type=read:status=DATA:mime=Lg==;${b64("text/plain\n")}\x07` +
            `\x1b]5522;type=read:status=DATA:mime=${b64("text/plain")};${b64("hello")}\x07` +
            "\x1b]5522;type=read:status=DONE\x07",
        );
        // An answered read is gone.
        expect(terminal.answerKittyClipboardRead(1, { status: "denied" })).toBe(false);
      });
    });

    it("answers refusals, busy beyond four held reads, and held reads when reads stop", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setClipboardPolicy({ readsToHost: true, writesAllowed: false });
        const read = `\x1b]5522;type=read;${b64("text/plain")}\x1b\\`;
        expect(write(read.repeat(4))).toBe("");
        expect(write(read)).toBe("\x1b]5522;type=read:status=EBUSY\x1b\\");
        expect(
          terminal.drainEvents().map((event) =>
            event.type === "kitty-clipboard-read" ? event.id : null,
          ),
        ).toEqual([1, 2, 3, 4]);
        expect(terminal.answerKittyClipboardRead(2, { status: "denied" })).toBe(true);
        expect(decoder.decode(terminal.drainOutputBytes())).toBe(
          "\x1b]5522;type=read:status=EPERM\x1b\\",
        );
        terminal.setClipboardPolicy({ readsToHost: false, writesAllowed: false });
        expect(decoder.decode(terminal.drainOutputBytes())).toBe(
          "\x1b]5522;type=read:status=EPERM\x1b\\".repeat(3),
        );
        expect(terminal.answerKittyClipboardRead(4, { status: "denied" })).toBe(false);
      });
    });

    it("hands allowed text writes to the host and refuses what it cannot write", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setClipboardPolicy({ readsToHost: false, writesAllowed: true });
        expect(write(kittyWrite("text/plain", "hi"))).toBe(
          "\x1b]5522;type=write:status=DONE\x1b\\",
        );
        expect(write(kittyWrite(null))).toBe(
          "\x1b]5522;type=write:status=DONE\x1b\\",
        );
        expect(write(kittyWrite("application/x-terax", "?"))).toBe(
          "\x1b]5522;type=write:status=ENOSYS\x1b\\",
        );
        expect(terminal.drainEvents()).toEqual([
          {
            type: "kitty-clipboard-write",
            primary: false,
            clear: false,
            contents: [{ mime: "text/plain", data: encoder.encode("hi") }],
          },
          { type: "kitty-clipboard-write", primary: false, clear: true, contents: [] },
        ]);
      });
    });

    /** A write of `parts`, each sent as wdata chunks of `chunk` bytes. */
    const kittyWriteParts = (
      parts: { mime: string; data: Uint8Array }[],
      chunk = 3 * 16 * 1024,
    ) => {
      let sequence = "\x1b]5522;type=write\x1b\\";
      for (const { mime, data } of parts) {
        for (let at = 0; at < data.byteLength; at += chunk) {
          sequence += `\x1b]5522;type=wdata:mime=${b64(mime)};${base64(data.subarray(at, at + chunk))}\x1b\\`;
        }
      }
      return `${sequence}\x1b]5522;type=wdata\x1b\\`;
    };

    it("hands images, with their text, and writes of megabytes to the host", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setClipboardPolicy({ readsToHost: false, writesAllowed: true });
        const png = Uint8Array.from({ length: 300 }, (_, index) => index & 0xff);
        // The first text and the first image are taken, the rest dropped.
        expect(
          write(
            kittyWriteParts([
              { mime: "text/plain", data: encoder.encode("alt") },
              { mime: "image/png", data: png },
              { mime: "image/jpeg", data: png.subarray(0, 3) },
            ]),
          ),
        ).toBe("\x1b]5522;type=write:status=DONE\x1b\\");
        expect(terminal.drainEvents()).toEqual([
          {
            type: "kitty-clipboard-write",
            primary: false,
            clear: false,
            contents: [
              { mime: "text/plain", data: encoder.encode("alt") },
              { mime: "image/png", data: png },
            ],
          },
        ]);

        // Far past the 256 KiB other events may carry.
        const large = patterned(3 * 1024 * 1024);
        expect(write(kittyWriteParts([{ mime: "image/png", data: large }]))).toBe(
          "\x1b]5522;type=write:status=DONE\x1b\\",
        );
        const [event] = terminal.drainEvents();
        const data = event?.type === "kitty-clipboard-write" ? event.contents[0]?.data : null;
        expect(data && Buffer.from(large).equals(data)).toBe(true);
      });
    });

    it("answers a read with megabytes of image", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setClipboardPolicy({ readsToHost: true, writesAllowed: false });
        write(`\x1b]5522;type=read;${b64("image/png")}\x1b\\`);
        const [read] = terminal.drainEvents();
        expect(read).toMatchObject({ type: "kitty-clipboard-read", mimes: ["image/png"] });
        // More than the 4 MiB a reply could once take.
        const image = patterned(6 * 1024 * 1024);
        expect(
          terminal.answerKittyClipboardRead(1, {
            status: "success",
            available: ["image/png"],
            contents: [{ mime: "image/png", data: image }],
          }),
        ).toBe(true);
        const reply = decoder.decode(terminal.drainOutputBytes());
        const chunks = [
          ...reply.matchAll(
            new RegExp(`\x1b\\]5522;type=read:status=DATA:mime=${b64("image/png")};([^\x1b]*)\x1b\\\\`, "g"),
          ),
        ].map((match) => Buffer.from(match[1], "base64"));
        expect(Buffer.concat(chunks).equals(image)).toBe(true);
        expect(reply.endsWith("\x1b]5522;type=read:status=DONE\x1b\\")).toBe(true);
      });
    });

    it("sends paste events whose password grants one follow-up read (mode 5522)", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setClipboardPolicy({ readsToHost: true, writesAllowed: true });
        expect(terminal.kittyPasteEvent(false, ["text/plain"])).toBe(false);
        write("\x1b[?5522h");
        expect(terminal.kittyPasteEvent(false, ["text/plain"])).toBe(true);
        const event = decoder.decode(terminal.drainOutputBytes());
        // Ghostty's event: the types on offer under a fresh password.
        const pw = /^\x1b\]5522;type=read:status=OK:pw=([^:;\x1b]+)\x1b\\/.exec(event)?.[1];
        expect(pw && atob(pw)).toMatch(/^[2-9a-km-zA-HJ-NP-Z]{22}$/);
        expect(event).toContain(
          `\x1b]5522;type=read:status=DATA:mime=Lg==:pw=${pw};${b64("text/plain\n")}\x1b\\`,
        );

        const read = (name: string) =>
          write(
            `\x1b]5522;type=read:${name ? `name=${b64(name)}:` : ""}pw=${pw};${b64("text/plain")}\x1b\\`,
          );
        // A password counts only with a name, and only once.
        read("");
        read("app");
        read("app");
        const reads = terminal.drainEvents();
        expect(
          reads.map((event) =>
            event.type === "kitty-clipboard-read" ? event.granted : null,
          ),
        ).toEqual([false, true, true]);
        // Replaying the granted read consumes the grant; the next is asked.
        terminal.answerKittyClipboardRead(2, { status: "denied" });
        read("app");
        expect(
          terminal.drainEvents().map((event) =>
            event.type === "kitty-clipboard-read" ? event.granted : null,
          ),
        ).toEqual([false]);

        // Reads that cannot reach the host would lose the paste.
        terminal.setClipboardPolicy({ readsToHost: false, writesAllowed: true });
        terminal.drainOutputBytes();
        expect(terminal.kittyPasteEvent(false, ["text/plain"])).toBe(false);
      });
    });

    it("leaves OSC 52 to the host's own handling", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setClipboardPolicy({ readsToHost: true, writesAllowed: true });
        expect(write("\x1b]52;c;?\x07")).toBe("");
        expect(terminal.drainEvents()).toEqual([
          { type: "clipboard-read", selection: "c", terminator: "bel" },
        ]);
      });
    });
  });

  describe("Kitty drag and drop (OSC 72)", () => {
    const position = {
      cellX: 4,
      cellY: 2,
      pixelX: 40,
      pixelY: 20,
      copy: true,
      move: false,
    };

    it("feeds native drags to a registered program", () => {
      withTerminal(80, 24, (terminal, write) => {
        // Unregistered: drags are not the program's.
        terminal.dndMove(position, ["text/plain"]);
        expect(decoder.decode(terminal.drainOutputBytes())).toBe("");
        expect(terminal.dndActive()).toBe(false);

        write("\x1b]72;t=a;text/plain text/uri-list\x1b\\");
        expect(terminal.dndActive()).toBe(true);
        terminal.dndMove(position, ["text/uri-list", "text/plain"]);
        expect(decoder.decode(terminal.drainOutputBytes())).toBe(
          "\x1b]72;t=m:x=4:y=2:X=40:Y=20:o=1:m=0;text/uri-list text/plain \x1b\\",
        );
        expect(terminal.dndAccepted()).toBeNull();
        write("\x1b]72;t=m:o=1;text/plain\x1b\\");
        expect(terminal.dndAccepted()).toBe("copy");

        terminal.dndDrop(position, [
          { mime: "text/uri-list", data: encoder.encode("file:///tmp/a.txt\r\n") },
          { mime: "text/plain", data: encoder.encode("hello") },
        ]);
        expect(decoder.decode(terminal.drainOutputBytes())).toBe(
          "\x1b]72;t=M:x=4:y=2:X=40:Y=20:o=1:m=0;text/uri-list text/plain \x1b\\",
        );
        expect(write("\x1b]72;t=r:x=2\x1b\\")).toBe(
          `\x1b]72;t=r:x=2:m=0;${base64(encoder.encode("hello"))}\x1b\\\x1b]72;t=r:x=2\x1b\\`,
        );
        write("\x1b]72;t=r:o=1\x1b\\");

        terminal.dndMove(position, ["text/plain"]);
        terminal.drainOutputBytes();
        terminal.dndLeave();
        expect(decoder.decode(terminal.drainOutputBytes())).toBe(
          "\x1b]72;t=m:x=-1:y=-1\x1b\\",
        );
        write("\x1b]72;t=A\x1b\\");
        expect(terminal.dndActive()).toBe(false);
        expect(terminal.drainEvents()).toEqual([
          { type: "drag-and-drop", change: "registration" },
          { type: "drag-and-drop", change: "acceptance" },
          { type: "drag-and-drop", change: "concluded", operation: "copy" },
          { type: "drag-and-drop", change: "registration" },
        ]);
      });
    });
  });

  describe("mouse encoding", () => {
    const left = 1;
    const press = {
      action: "press",
      button: left,
      mods: 0,
      anyButtonPressed: true,
    } as const;

    it("encodes nothing until the program enables tracking", () => {
      withTerminal(80, 24, (terminal) => {
        terminal.setPixelSize(800, 480);
        expect(terminal.encodeMouse({ ...press, x: 25, y: 65 })).toHaveLength(
          0,
        );
      });
    });

    it("encodes SGR presses, releases, wheel and modifiers in cells", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setPixelSize(800, 480);
        write("\x1b[?1000h\x1b[?1006h");
        const text = (bytes: Uint8Array) => decoder.decode(bytes);
        expect(text(terminal.encodeMouse({ ...press, x: 25, y: 65 }))).toBe(
          "\x1b[<0;3;4M",
        );
        expect(
          text(
            terminal.encodeMouse({
              ...press,
              action: "release",
              anyButtonPressed: false,
              x: 25,
              y: 65,
            }),
          ),
        ).toBe("\x1b[<0;3;4m");
        expect(
          text(terminal.encodeMouse({ ...press, button: 4, x: 0, y: 0 })),
        ).toBe("\x1b[<64;1;1M");
        expect(
          text(terminal.encodeMouse({ ...press, button: 7, x: 0, y: 0 })),
        ).toBe("\x1b[<67;1;1M");
        expect(
          text(
            terminal.encodeMouse({
              ...press,
              mods: Mods.SHIFT | Mods.CTRL,
              x: 0,
              y: 0,
            }),
          ),
        ).toBe("\x1b[<20;1;1M");
        // Mode 1000 has no motion.
        expect(
          terminal.encodeMouse({
            ...press,
            action: "motion",
            button: 0,
            anyButtonPressed: false,
            x: 95,
            y: 5,
          }),
        ).toHaveLength(0);
      });
    });

    it("reports any-motion once per cell, and pixels under mode 1016", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setPixelSize(800, 480);
        write("\x1b[?1003h\x1b[?1006h");
        const motion = {
          action: "motion",
          button: 0,
          mods: 0,
          anyButtonPressed: false,
        } as const;
        expect(
          decoder.decode(terminal.encodeMouse({ ...motion, x: 11, y: 1 })),
        ).toBe("\x1b[<35;2;1M");
        expect(terminal.encodeMouse({ ...motion, x: 19, y: 19 })).toHaveLength(
          0,
        );
        terminal.resetMouseMotion();
        expect(
          decoder.decode(terminal.encodeMouse({ ...motion, x: 19, y: 19 })),
        ).toBe("\x1b[<35;2;1M");

        // SGR-pixels reports the pixel position itself (Ghostty's encoding).
        write("\x1b[?1016h");
        expect(
          decoder.decode(terminal.encodeMouse({ ...motion, x: 123, y: 45 })),
        ).toBe("\x1b[<35;123;45M");
      });
    });

    it("encodes legacy X10 coordinates", () => {
      withTerminal(80, 24, (terminal, write) => {
        terminal.setPixelSize(800, 480);
        write("\x1b[?1000h");
        expect([...terminal.encodeMouse({ ...press, x: 25, y: 65 })]).toEqual([
          0x1b,
          0x5b,
          0x4d,
          32,
          32 + 3,
          32 + 4,
        ]);
      });
    });
  });

  describe("VT export", () => {
    it("exports styled, unwrapped history that replays at another width", () => {
      withTerminal(10, 4, (terminal, write) => {
        write(
          "\x1b[31mred\x1b[0m plain \x1b]8;;https://terax.app\x1b\\link\x1b]8;;\x1b\\ wrapped-line",
        );
        // Styles survive; hyperlink targets are not part of the export.
        const vt = terminal.formatTextRange(0, 3, "vt");
        expect(vt).toContain("\x1b[38;5;1mred");
        expect(terminal.formatTextRange(0, 3, "plain")).toBe(
          "red plain link wrapped-line",
        );
        expect(terminal.formatTextRange(0, 0, "html")).toContain("red");

        const replay = ghostty.createTerminal(40, 4);
        try {
          replay.write(encoder.encode(vt));
          expect(replay.readTextRange(0, 0).trimEnd()).toBe(
            "red plain link wrapped-line",
          );
        } finally {
          replay.dispose();
        }
      });
    });
  });
});
