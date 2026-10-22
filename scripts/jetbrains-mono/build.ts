// Builds the bundled JetBrains Mono: the official variable fonts (upright and
// italic, weights 100-800) with every glyph, split by Unicode range so a
// webview downloads a segment only when it draws one of its characters.
//
// Downloads the pinned release, checks its digest and writes:
//
//   src/assets/fonts/jetbrains-mono/<style>-<segment>.woff2
//   src/assets/fonts/jetbrains-mono/OFL.txt   licence (bundled with the app)
//   src/styles/jetbrains-mono.css             one @font-face per style and segment
//
// Every OpenType feature is kept (ligatures, stylistic sets, character
// variants), and so are the variation tables, so each file covers the whole
// weight axis. Private Use Area code points are left to "Terax Symbols" and the
// emoji variation selectors to the system's emoji font. Re-run after changing
// the pinned release or the segment table:
//
//   bun scripts/jetbrains-mono/build.ts

import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runMain, SystemExit } from "../lib/errors.ts";
import {
  cmapCodepoints,
  fetchVerified,
  hex,
  loadHarfBuzz,
  subsetter,
  unicodeRange,
} from "../lib/fonts.ts";

const VERSION = "2.304";
const URL_ =
  "https://github.com/JetBrains/JetBrainsMono/releases/download/" +
  `v${VERSION}/JetBrainsMono-${VERSION}.zip`;
const SHA256 =
  "6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf";
const FAMILY = "JetBrains Mono";
const WEIGHTS = "100 800";

export const STYLES = [
  ["normal", "fonts/variable/JetBrainsMono[wght].ttf"],
  ["italic", "fonts/variable/JetBrainsMono-Italic[wght].ttf"],
] as const;

type Range = readonly [start: number, end: number];

/**
 * Segments in priority order: a code point belongs to the first segment
 * naming it, and "other" takes whatever the font has beyond these. "latin" is
 * what ordinary text and code need and loads with the first terminal.
 */
export const SEGMENTS: readonly (readonly [string, readonly Range[]])[] = [
  [
    "latin",
    [
      [0x0000, 0x00ff],
      [0x0131, 0x0131],
      [0x0152, 0x0153],
      [0x02bb, 0x02bc],
      [0x02c6, 0x02c6],
      [0x02da, 0x02da],
      [0x02dc, 0x02dc],
      [0x2000, 0x206f], // General Punctuation: dashes, quotes, ellipsis
      [0x20ac, 0x20ac],
      [0x2122, 0x2122],
      [0x2212, 0x2212],
      [0xfeff, 0xfeff],
      [0xfffd, 0xfffd],
    ],
  ],
  [
    "latin-ext",
    [
      [0x0100, 0x036f], // Latin Extended A/B, IPA, modifiers, combining marks
      [0x1e00, 0x1eff], // Latin Extended Additional (Vietnamese)
      [0x20a0, 0x20cf], // currency
      [0x2c60, 0x2c7f],
      [0xa720, 0xa7ff],
    ],
  ],
  [
    "greek-cyrillic",
    [
      [0x0370, 0x052f],
      [0x1c80, 0x1c8f],
      [0x1f00, 0x1fff],
      [0x2de0, 0x2dff],
      [0xa640, 0xa69f],
    ],
  ],
  [
    "box",
    // Drawn procedurally in the terminal; the editor and chat use these.
    [
      [0x2500, 0x259f],
      [0x2800, 0x28ff],
      [0x1cc00, 0x1cebf],
      [0x1fb00, 0x1fbff],
    ],
  ],
  [
    "symbols",
    [
      [0x2070, 0x209f], // super- and subscripts
      [0x2100, 0x24ff], // letterlike, number forms, arrows, maths, technical
      [0x25a0, 0x27ff], // shapes, miscellaneous symbols, dingbats
      [0x2900, 0x2bff], // more arrows and maths
    ],
  ],
  ["other", []],
];

export function excluded(codepoint: number): boolean {
  return (
    (codepoint >= 0xe000 && codepoint <= 0xf8ff) || // Terax Symbols
    (codepoint >= 0xf0000 && codepoint <= 0x10fffd) ||
    (codepoint >= 0xfe00 && codepoint <= 0xfe0f) // emoji presentation
  );
}

export function assign(codepoints: Iterable<number>): Map<string, number[]> {
  const assigned = new Map<string, number[]>(
    SEGMENTS.map(([name]) => [name, []]),
  );
  for (const codepoint of [...codepoints].sort((a, b) => a - b)) {
    if (excluded(codepoint)) continue;
    const owner =
      SEGMENTS.find(([, ranges]) =>
        ranges.some(([start, end]) => start <= codepoint && codepoint <= end),
      )?.[0] ?? "other";
    assigned.get(owner)?.push(codepoint);
  }
  for (const [name, list] of assigned)
    if (list.length === 0)
      throw new SystemExit(`segment ${name} has no glyphs`);
  return assigned;
}

async function download(): Promise<{
  fonts: Map<string, Uint8Array>;
  licence: string;
}> {
  const archive = await fetchVerified(URL_, SHA256);
  const scratch = await mkdtemp(join(tmpdir(), "terax-jetbrains-mono-"));
  try {
    const path = join(scratch, "archive.zip");
    const out = join(scratch, "out");
    await writeFile(path, archive);
    await mkdir(out);
    // unzip reads "[wght]" in a member name as a wildcard, so take the folder.
    const unzip = spawnSync(
      "unzip",
      ["-q", "-o", path, "fonts/variable/*", "OFL.txt", "-d", out],
      { encoding: "utf8" },
    );
    if (unzip.error)
      throw new SystemExit(`could not run unzip: ${unzip.error.message}`);
    if (unzip.status !== 0)
      throw new SystemExit(`${URL_}: ${unzip.stderr.trim() || "unzip failed"}`);
    const fonts = new Map<string, Uint8Array>();
    for (const [style, member] of STYLES)
      fonts.set(style, new Uint8Array(await readFile(join(out, member))));
    return { fonts, licence: await readFile(join(out, "OFL.txt"), "utf8") };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const ROOT = resolve(import.meta.dirname, "../..");
const ASSETS = join(ROOT, "src/assets/fonts/jetbrains-mono");
const CSS = join(ROOT, "src/styles/jetbrains-mono.css");

async function main(): Promise<void> {
  const { fonts, licence } = await download();
  const { compress } = await import("wawoff2");
  const hb = await loadHarfBuzz();

  await mkdir(ASSETS, { recursive: true });
  for (const entry of await readdir(ASSETS))
    if (entry.endsWith(".woff2")) await unlink(join(ASSETS, entry));
  const faces: string[] = [];
  for (const [style] of STYLES) {
    const source = fonts.get(style) as Uint8Array;
    const assigned = assign(cmapCodepoints(source));
    const font = subsetter(hb, source, {
      hinting: true,
      layoutFeatures: "all",
      nameIds: [0, 1, 2, 3, 4, 5, 6],
    });
    try {
      for (const [segment] of SEGMENTS) {
        const codepoints = assigned.get(segment) ?? [];
        const name = `${style}-${segment}.woff2`;
        const path = join(ASSETS, name);
        await writeFile(path, await compress(font.subset(codepoints)));
        console.log(
          `${relative(ROOT, path)}: ${codepoints.length} code points, ${(await stat(path)).size} bytes`,
        );
        faces.push(
          "@font-face {\n" +
            `  font-family: '${FAMILY}';\n` +
            `  font-style: ${style};\n` +
            `  font-weight: ${WEIGHTS};\n` +
            "  font-display: swap;\n" +
            `  src: url('../assets/fonts/jetbrains-mono/${name}') format('woff2');\n` +
            `  unicode-range: ${unicodeRange(codepoints)};\n` +
            "}\n",
        );
      }
    } finally {
      font.dispose();
    }
  }

  await writeFile(
    CSS,
    `/* Generated by scripts/jetbrains-mono/build.ts from JetBrains Mono ${VERSION}; do not edit.\n` +
      " * The variable fonts with every glyph and feature, upright and italic, split by\n" +
      " * Unicode range: a segment downloads the first time one of its characters is\n" +
      ` * drawn. Private Use Area code points (U+${hex(0xe000)}-${hex(0xf8ff)} and planes 15-16)\n` +
      " * are left to Terax Symbols, emoji variation selectors to the system. */\n" +
      faces.join("\n"),
  );
  await writeFile(
    join(ASSETS, "OFL.txt"),
    `JetBrains Mono ${VERSION} (https://github.com/JetBrains/JetBrainsMono), the\n` +
      "variable fonts split into WOFF2 files by Unicode range by\n" +
      "scripts/jetbrains-mono/build.ts. Glyph outlines, metrics and OpenType\n" +
      "features are unchanged.\n\n" +
      licence,
  );
}

if (import.meta.main) await runMain(main);
