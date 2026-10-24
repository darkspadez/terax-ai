// Builds the bundled Nerd Font symbol fallback ("Oarlock Symbols").
//
// Downloads the pinned Symbols Nerd Font release, checks its digest, splits the
// font's Private Use Area glyphs into one WOFF2 per icon set and writes:
//
//   src/assets/fonts/symbols/<segment>.woff2   unhinted subsets
//   src/assets/fonts/symbols/NOTICE.txt        licence notice (bundled with the app)
//   src/styles/symbols.css                     one @font-face per segment
//
// Each @font-face covers only the codepoints its file contains, all of them in
// the Private Use Area, so a webview fetches a segment the first time one of its
// icons is drawn and never for ordinary text. Re-run after changing the pinned
// release or the segment table:
//
//   bun scripts/symbols-font/build.ts
//
// Subsetting is HarfBuzz's hb-subset (harfbuzzjs), WOFF2 encoding Google's
// woff2 (wawoff2), both WebAssembly. The archive is unpacked with the system
// `tar` because Bun has no xz decoder.

import { spawnSync } from "node:child_process";
import {
  lstat,
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
import { pyRepr } from "../lib/format.ts";

const VERSION = "3.5.1";
const URL_ =
  "https://github.com/ryanoasis/nerd-fonts/releases/download/" +
  `v${VERSION}/NerdFontsSymbolsOnly.tar.xz`;
const SHA256 =
  "01172f37db8543edb102e5cb5c64101c9f4686630804d49b419aa07b23a69996";
const FONT = "SymbolsNerdFont-Regular.ttf";
const FAMILY = "Oarlock Symbols";

type Range = readonly [start: number, end: number];

// Icon sets in Nerd Fonts 3.x code point order. Material Design is split in
// three so one icon does not pull in all 400 kB of it.
export const SEGMENTS: readonly (readonly [string, readonly Range[]])[] = [
  ["powerline", [[0xe000, 0xe0ff]]], // Pomicons, Powerline, Powerline Extra
  ["font-awesome-extension", [[0xe200, 0xe2ff]]],
  ["weather", [[0xe300, 0xe3ff]]],
  ["seti", [[0xe500, 0xe6ff]]],
  ["devicons", [[0xe700, 0xe9ff]]],
  ["codicons", [[0xea00, 0xecff]]],
  ["font-awesome", [[0xed00, 0xf2ff]]],
  ["font-logos", [[0xf300, 0xf3ff]]],
  ["octicons", [[0xf400, 0xf8ff]]],
  ["material-design-1", [[0xf0000, 0xf08ff]]],
  ["material-design-2", [[0xf0900, 0xf11ff]]],
  ["material-design-3", [[0xf1200, 0xf1aff]]],
];

const ICON_SETS = `\
| Icon set               | Upstream                                              | Licence     |
|------------------------|-------------------------------------------------------|-------------|
| Codicons               | https://github.com/microsoft/vscode-codicons          | CC BY 4.0   |
| Devicons               | https://github.com/devicons/devicon                   | MIT         |
| Font Awesome           | https://github.com/FortAwesome/Font-Awesome           | CC BY 4.0   |
| Font Awesome Extension | https://github.com/AndreLZGava/font-awesome-extension | MIT         |
| Font Logos             | https://github.com/lukas-w/font-logos                 | Unlicense   |
| Material Design Icons  | https://github.com/Templarian/MaterialDesign-Font     | Apache 2.0  |
| Octicons               | https://github.com/primer/octicons                    | MIT         |
| Seti-UI and original   | https://github.com/jesseweed/seti-ui                  | MIT         |
| Pomicons               | https://github.com/gabrielelana/pomicons              | OFL 1.1 RFN |
| Powerline Extra        | https://github.com/ryanoasis/powerline-extra-symbols  | MIT         |
| Powerline Symbols      | https://github.com/powerline/powerline                | MIT         |
| Weather Icons          | https://github.com/erikflowers/weather-icons          | OFL 1.1     |
`;

const ROOT = resolve(import.meta.dirname, "../..");
const ASSETS = join(ROOT, "src/assets/fonts/symbols");
const CSS = join(ROOT, "src/styles/symbols.css");

export function privateUse(codepoint: number): boolean {
  return (
    (0xe000 <= codepoint && codepoint <= 0xf8ff) ||
    (0xf0000 <= codepoint && codepoint <= 0x10fffd)
  );
}

export function assign(codepoints: Iterable<number>): Map<string, number[]> {
  const assigned = new Map<string, number[]>(
    SEGMENTS.map(([name]) => [name, []]),
  );
  for (const codepoint of [...codepoints].sort((a, b) => a - b)) {
    if (!privateUse(codepoint)) continue; // ordinary characters keep the system fallback
    const owners = SEGMENTS.filter(([, ranges]) =>
      ranges.some(([start, end]) => start <= codepoint && codepoint <= end),
    ).map(([name]) => name);
    if (owners.length !== 1)
      throw new SystemExit(
        `U+${hex(codepoint)} belongs to ${owners.length ? pyRepr(owners) : "no segment"}`,
      );
    assigned.get(owners[0])?.push(codepoint);
  }
  const empty = [...assigned]
    .filter(([, list]) => list.length === 0)
    .map(([name]) => name);
  if (empty.length)
    throw new SystemExit(`segments without glyphs: ${pyRepr(empty)}`);
  return assigned;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function download(): Promise<{ source: Uint8Array; licence: string }> {
  const archive = await fetchVerified(URL_, SHA256);
  const scratch = await mkdtemp(join(tmpdir(), "oarlock-symbols-font-"));
  try {
    const path = join(scratch, "archive.tar.xz");
    const out = join(scratch, "out");
    await writeFile(path, archive);
    await mkdir(out);
    const tar = spawnSync(
      "tar",
      ["-x", "-J", "--no-same-owner", "-f", path, "-C", out, FONT, "LICENSE"],
      { encoding: "utf8" },
    );
    if (tar.error)
      throw new SystemExit(`could not run tar: ${tar.error.message}`);
    const members = [join(out, FONT), join(out, "LICENSE")];
    const present = await Promise.all(
      members.map((member) =>
        lstat(member).then(
          (info) => info.isFile(),
          () => false,
        ),
      ),
    );
    if (tar.status !== 0 || !present.every(Boolean))
      throw new SystemExit(`${URL_}: missing ${FONT} or LICENSE`);
    const [source, licence] = await Promise.all([
      readFile(members[0]),
      readFile(members[1], "utf8"),
    ]);
    return { source: new Uint8Array(source), licence };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { source, licence } = await download();
  const assigned = assign(cmapCodepoints(source));
  const { compress } = await import("wawoff2");
  // Unhinted, no layout features, names 0-6, FontForge private data dropped.
  const fonts = subsetter(await loadHarfBuzz(), source, {
    hinting: false,
    layoutFeatures: "none",
    nameIds: [0, 1, 2, 3, 4, 5, 6],
    dropTables: ["PfEd"],
  });

  await mkdir(ASSETS, { recursive: true });
  for (const entry of await readdir(ASSETS))
    if (entry.endsWith(".woff2")) await unlink(join(ASSETS, entry));
  const faces: string[] = [];
  try {
    for (const [name] of SEGMENTS) {
      const codepoints = assigned.get(name) ?? [];
      const path = join(ASSETS, `${name}.woff2`);
      await writeFile(path, await compress(fonts.subset(codepoints)));
      console.log(
        `${relative(ROOT, path)}: ${codepoints.length} glyphs, ${(await stat(path)).size} bytes`,
      );
      faces.push(
        "@font-face {\n" +
          `  font-family: '${FAMILY}';\n` +
          "  font-style: normal;\n" +
          "  font-weight: 100 900;\n" +
          "  font-display: block;\n" +
          `  src: url('../assets/fonts/symbols/${name}.woff2') format('woff2');\n` +
          `  unicode-range: ${unicodeRange(codepoints)};\n` +
          "}\n",
      );
    }
  } finally {
    fonts.dispose();
  }

  await writeFile(
    CSS,
    `/* Generated by scripts/symbols-font/build.ts from Symbols Nerd Font ${VERSION}; do not edit.\n` +
      " * Last-resort symbols for the terminal font stack (src/lib/fonts.ts). Private Use Area\n" +
      " * only: a segment downloads the first time one of its icons is drawn. */\n" +
      faces.join("\n"),
  );
  await writeFile(
    join(ASSETS, "NOTICE.txt"),
    `Oarlock Symbols is Symbols Nerd Font ${VERSION} (https://github.com/ryanoasis/nerd-fonts),\n` +
      "split into one WOFF2 file per icon set and stripped of hinting by\n" +
      "scripts/symbols-font/build.ts. Glyph outlines are unchanged.\n\n" +
      "The glyphs come from these projects, under these licences:\n\n" +
      `${ICON_SETS}\n` +
      "Nerd Fonts licence:\n\n" +
      licence,
  );
}

if (import.meta.main) await runMain(main);
