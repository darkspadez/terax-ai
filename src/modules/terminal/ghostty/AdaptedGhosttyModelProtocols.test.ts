import { readFile } from "node:fs/promises";
import { TeraxGhostty } from "@terax/ghostty-core/adapted";
import { beforeAll, describe, expect, it } from "vitest";
import { AdaptedGhosttyTerminalModel } from "./AdaptedGhosttyTerminalModel";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const red = Buffer.from([255, 0, 0]).toString("base64");

describe.each(["ghostty-vt", "ghostty-vt-scalar"])(
  "adapted Ghostty model protocols (%s)",
  (artifact) => {
    let core: TeraxGhostty;

    beforeAll(async () => {
      const file = await readFile(
        new URL(
          `../../../../packages/ghostty-core/adapted/${artifact}.wasm`,
          import.meta.url,
        ),
      );
      core = await TeraxGhostty.loadBytes(Uint8Array.from(file).buffer);
    });

    function create(
      backend: "ghostty-webgpu" | "ghostty-webgl" = "ghostty-webgpu",
    ) {
      const replies: string[] = [];
      const model = new AdaptedGhosttyTerminalModel(core, {
        backend,
        cols: 80,
        rows: 24,
        onReply: (bytes) => replies.push(decoder.decode(bytes)),
      });
      model.setPixelSize(800, 480);
      return {
        model,
        replies,
        write: (text: string) => model.write(encoder.encode(text)),
      };
    }

    it("delivers mode 2048 reports from resize and cell-size changes to the PTY", () => {
      const { model, replies, write } = create();
      try {
        write("\x1b[?2048h");
        model.resize(100, 30);
        model.setPixelSize(1000, 600);
        model.setPixelSize(2000, 1200);
        expect(replies).toEqual([
          "\x1b[48;24;80;480;800t",
          "\x1b[48;30;100;600;1000t",
          "\x1b[48;30;100;1200;2000t",
        ]);
      } finally {
        model.dispose();
      }
    });

    it("delivers colour scheme and visibility changes to the PTY", () => {
      const { model, replies, write } = create();
      try {
        write("\x1b[?2031h\x1b[?2033h");
        replies.length = 0;
        model.setColorScheme("light");
        model.setVisible(false);
        expect(replies).toEqual(["\x1b[?997;2n", "\x1b[?999;2n"]);
        model.setTerminalVersion("terax 9.9.9");
        write("\x1b[>q");
        expect(replies[replies.length - 1]).toBe("\x1bP>|terax 9.9.9\x1b\\");
      } finally {
        model.dispose();
      }
    });

    it("redraws everything when only image placements change (GPU frames)", () => {
      const { model, write } = create();
      try {
        write("text");
        model.consumeGpuFrame();
        expect(model.consumeGpuFrame().damage.kind).toBe("none");

        write(`\x1b[2;2H\x1b_Gi=1,a=T,f=24,s=1,v=1,q=2;${red}\x1b\\`);
        const frame = model.consumeGpuFrame();
        expect(frame.damage.kind).toBe("full");
        expect(model.imagePlacements()).toMatchObject([
          { imageId: 1, col: 1, row: 1, channels: 3 },
        ]);

        write("\x1b_Ga=d,d=A,q=2\x1b\\");
        expect(model.consumeGpuFrame().damage.kind).toBe("full");
        expect(model.imagePlacements()).toEqual([]);
      } finally {
        model.dispose();
      }
    });

    it("redraws everything when only image placements change (cell arrays)", () => {
      const { model, write } = create("ghostty-webgl");
      try {
        write("text");
        model.consumeDamage();
        write(`\x1b_Gi=2,a=T,f=24,s=1,v=1,q=2;${red}\x1b\\`);
        expect(model.consumeDamage().kind).toBe("full");
        expect(model.imagePlacements().map((p) => p.imageId)).toEqual([2]);
      } finally {
        model.dispose();
      }
    });

    it("encodes mouse events through the model and exports VT ranges", () => {
      const { model, write } = create();
      try {
        write("\x1b[?1000h\x1b[?1006h\x1b[32mgreen\x1b[0m");
        expect(
          decoder.decode(
            model.encodeMouse({
              action: "press",
              button: 1,
              mods: 0,
              x: 5,
              y: 5,
              anyButtonPressed: true,
            }),
          ),
        ).toBe("\x1b[<0;1;1M");
        expect(model.formatTextRange(0, 0, "vt")).toContain(
          "\x1b[38;5;2mgreen",
        );
      } finally {
        model.dispose();
      }
    });
  },
);
