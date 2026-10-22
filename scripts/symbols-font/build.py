#!/usr/bin/env python3
"""Builds the bundled Nerd Font symbol fallback ("Terax Symbols").

Downloads the pinned Symbols Nerd Font release, checks its digest, splits the
font's Private Use Area glyphs into one WOFF2 per icon set and writes:

  src/assets/fonts/symbols/<segment>.woff2   unhinted subsets
  src/assets/fonts/symbols/NOTICE.txt        licence notice (bundled with the app)
  src/styles/symbols.css                     one @font-face per segment

Each @font-face covers only the codepoints its file contains, all of them in
the Private Use Area, so a webview fetches a segment the first time one of its
icons is drawn and never for ordinary text. Re-run after changing the pinned
release or the segment table:

  python3 -m pip install fonttools brotli
  python3 scripts/symbols-font/build.py
"""

from __future__ import annotations

import hashlib
import io
import tarfile
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

VERSION = "3.5.1"
URL = (
    "https://github.com/ryanoasis/nerd-fonts/releases/download/"
    f"v{VERSION}/NerdFontsSymbolsOnly.tar.xz"
)
SHA256 = "01172f37db8543edb102e5cb5c64101c9f4686630804d49b419aa07b23a69996"
FONT = "SymbolsNerdFont-Regular.ttf"
FAMILY = "Terax Symbols"

# Icon sets in Nerd Fonts 3.x code point order. Material Design is split in
# three so one icon does not pull in all 400 kB of it.
SEGMENTS: list[tuple[str, list[tuple[int, int]]]] = [
    ("powerline", [(0xE000, 0xE0FF)]),  # Pomicons, Powerline, Powerline Extra
    ("font-awesome-extension", [(0xE200, 0xE2FF)]),
    ("weather", [(0xE300, 0xE3FF)]),
    ("seti", [(0xE500, 0xE6FF)]),
    ("devicons", [(0xE700, 0xE9FF)]),
    ("codicons", [(0xEA00, 0xECFF)]),
    ("font-awesome", [(0xED00, 0xF2FF)]),
    ("font-logos", [(0xF300, 0xF3FF)]),
    ("octicons", [(0xF400, 0xF8FF)]),
    ("material-design-1", [(0xF0000, 0xF08FF)]),
    ("material-design-2", [(0xF0900, 0xF11FF)]),
    ("material-design-3", [(0xF1200, 0xF1AFF)]),
]

ICON_SETS = """\
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
"""

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "src/assets/fonts/symbols"
CSS = ROOT / "src/styles/symbols.css"


def private_use(codepoint: int) -> bool:
    return 0xE000 <= codepoint <= 0xF8FF or 0xF0000 <= codepoint <= 0x10FFFD


def runs(codepoints: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for codepoint in sorted(codepoints):
        if out and codepoint == out[-1][1] + 1:
            out[-1] = (out[-1][0], codepoint)
        else:
            out.append((codepoint, codepoint))
    return out


def unicode_range(codepoints: list[int]) -> str:
    return ", ".join(
        f"U+{start:X}" if start == end else f"U+{start:X}-{end:X}"
        for start, end in runs(codepoints)
    )


def download() -> tuple[bytes, str]:
    with urllib.request.urlopen(URL) as response:
        archive = response.read()
    digest = hashlib.sha256(archive).hexdigest()
    if digest != SHA256:
        raise SystemExit(f"{URL}: sha256 {digest}, expected {SHA256}")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:xz") as tar:
        font = tar.extractfile(FONT)
        licence = tar.extractfile("LICENSE")
        if font is None or licence is None:
            raise SystemExit(f"{URL}: missing {FONT} or LICENSE")
        return font.read(), licence.read().decode()


def assign(cmap: dict[int, str]) -> dict[str, list[int]]:
    assigned: dict[str, list[int]] = {name: [] for name, _ in SEGMENTS}
    for codepoint in sorted(cmap):
        if not private_use(codepoint):
            continue  # ordinary characters keep the system fallback
        owners = [
            name
            for name, ranges in SEGMENTS
            if any(start <= codepoint <= end for start, end in ranges)
        ]
        if len(owners) != 1:
            raise SystemExit(f"U+{codepoint:X} belongs to {owners or 'no segment'}")
        assigned[owners[0]].append(codepoint)
    empty = [name for name, codepoints in assigned.items() if not codepoints]
    if empty:
        raise SystemExit(f"segments without glyphs: {empty}")
    return assigned


def write_subset(source: bytes, codepoints: list[int], path: Path) -> None:
    options = subset.Options()
    options.flavor = "woff2"
    options.hinting = False
    options.layout_features = []
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    options.drop_tables += ["PfEd"]  # FontForge private data
    font = TTFont(io.BytesIO(source), recalcTimestamp=False)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(path, reorderTables=False)


def main() -> None:
    source, licence = download()
    cmap = TTFont(io.BytesIO(source)).getBestCmap()
    assigned = assign(cmap)

    ASSETS.mkdir(parents=True, exist_ok=True)
    for stale in ASSETS.glob("*.woff2"):
        stale.unlink()
    faces = []
    for name, _ in SEGMENTS:
        codepoints = assigned[name]
        path = ASSETS / f"{name}.woff2"
        write_subset(source, codepoints, path)
        print(f"{path.relative_to(ROOT)}: {len(codepoints)} glyphs, {path.stat().st_size} bytes")
        faces.append(
            "@font-face {\n"
            f"  font-family: '{FAMILY}';\n"
            "  font-style: normal;\n"
            "  font-weight: 100 900;\n"
            "  font-display: block;\n"
            f"  src: url('../assets/fonts/symbols/{name}.woff2') format('woff2');\n"
            f"  unicode-range: {unicode_range(codepoints)};\n"
            "}\n"
        )

    CSS.write_text(
        f"/* Generated by scripts/symbols-font/build.py from Symbols Nerd Font {VERSION}; do not edit.\n"
        " * Last-resort symbols for the terminal font stack (src/lib/fonts.ts). Private Use Area\n"
        " * only: a segment downloads the first time one of its icons is drawn. */\n"
        + "\n".join(faces)
    )
    (ASSETS / "NOTICE.txt").write_text(
        f"Terax Symbols is Symbols Nerd Font {VERSION} (https://github.com/ryanoasis/nerd-fonts),\n"
        "split into one WOFF2 file per icon set and stripped of hinting by\n"
        "scripts/symbols-font/build.py. Glyph outlines are unchanged.\n\n"
        "The glyphs come from these projects, under these licences:\n\n"
        f"{ICON_SETS}\n"
        "Nerd Fonts licence:\n\n"
        f"{licence}"
    )


if __name__ == "__main__":
    main()
