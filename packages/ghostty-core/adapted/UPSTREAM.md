# Terax Ghostty WASM adaptation

This is the production-candidate terminal core for the pooled Terax renderer
architecture. It adapts the mature bulk render-state bridge from Restty
without importing Restty's application runtime, PTY transport, perpetual
per-terminal frame loop, or per-pane GPU lifecycle.

- Ghostty source: `https://github.com/ghostty-org/ghostty`
- Ghostty commit: `ad97d331459a0762f7aea5f56fe86748e03b860f`
- Restty source: `https://github.com/wiedymi/restty`
- Restty commit: `7700b14a7643ba9240818209ef1e0aa90d83ad77`
- Zig: `0.16.0`
- Optimization: `ReleaseFast`, WebAssembly SIMD and scalar variants
- SIMD artifact size: `1072395` bytes
- Scalar artifact size: `1013358` bytes
- SIMD SHA-256: `d1f340dd853a20890da36c2f2a219163b5f90c1fdc2f8ced198fbfb64cc985f9`
- Scalar SHA-256: `4551745880269c49ad90a119f0f6415273e0a46deb47ca420c41680a74697d1d`

Terax-specific changes include:

- rebasing the bridge onto the pinned current Ghostty API;
- Ghostty `TinyIo`, avoiding the binary and runtime overhead of threaded I/O;
- independent hard byte and line limits for scrollback;
- a 256 KB maximum retained terminal-reply queue per terminal;
- raw `Uint8Array` PTY writes and replies with no UTF-8 round trip;
- prompt input capability for shells that need direct input instead of blocks;
- native Ghostty key encoding and terminal mode queries in the same instance;
- native tracked selections that survive streaming and reflow, clamp when
  partially pruned, and release their tracked pins deterministically;
- bounded parser-owned semantic events for shell and product integration;
- optional parser-time command markers with 2,048 tracked pins per terminal,
  exact endpoint columns, full signed exit codes, and deterministic cleanup;
- parser-time block invalidation for primary-screen clear and reset, retaining
  bounded marker capacity and preserving later markers within the same write;
- direct text range extraction independent of viewport or selection state;
- current geometry queries even before a hidden terminal synchronizes rendering;
- native mode, size, color, visibility, and version query replies;
- generated upstream Ghostty XTGETTCAP responses and native DECRQSS replies;
- synchronized-output state for damage suppression with bounded recovery;
- one WebAssembly instance (one linear memory) per Terax model, all created
  from a single compiled module; disposing the model drops the instance, which
  is the only way WebAssembly memory is ever returned to the operating system;
- Ghostty's module-global exact-page WASM pool, avoiding geometric page-pool
  growth; it is per terminal now because the pool lives in the instance;
- a 96 KiB shadow stack placed below the data (`-Dwasm-stack-kib`, default 96),
  so a blank instance is 5 pages (320 KiB) instead of 20 and an overflow traps
  instead of corrupting memory;
- `restty_set_scrollback_limits` and `restty_scrollback_page_bytes`, which let
  the host divide a global scrollback budget without pruning held history;
- upstream OSC SIMD scanning plus row-recycling, cursor, hyperlink, C0/C1,
  Kitty clipboard, and page-pointer correctness fixes through the pinned tip;
- synchronous SIMD capability detection with a scalar Ghostty artifact for
  older webviews, preserving the same model and renderer architecture;
- cached typed views that are recreated only when WASM memory or pointers move;
- capacity-aware render buffers with bounded headroom, preventing allocation
  churn during repeated window fitting and adjacent-size resize cycles;
- one reallocatable cell-buffer arena instead of sixteen independent WASM
  allocations, removing resize fragmentation and transient high-water growth;
- lazy cell-buffer allocation, with cell arrays, graphemes, links and placement
  snapshots returned to the allocator when presentation is released;
- explicit post-gesture bridge and render-state compaction with hysteresis;
- periodic render-state renewal after 100,000 updates, releasing fragmented
  row arenas and retained high-water allocations during long-running agents;
- explicit presentation-state release for hidden panes and hidden documents,
  with lazy rebuilding that preserves the terminal, selection, and scrollback;
- bounded reusable PTY input, terminal-reply, grapheme, and hyperlink bridge
  storage with oversized transient buffers released after use;
- direct consumption of libghostty's global and per-row dirty state, avoiding
  redundant full-viewport hashing and bridge-array rewrites;
- stable append-only grapheme and hyperlink storage between partial frames,
  with bounded full compaction after high-water thresholds;
- persistent hyperlink interning by owned buffer offsets, avoiding both repeated
  URI retention on dirty rows and borrowed pointers into recycled terminal pages;
- direct typed render-state consumption without a per-frame JS cell repack;
- a per-terminal render format (`restty_set_render_format`): 0 keeps the
  structure-of-arrays cells for the WebGL fallback, 1 writes GPU cell records
  and none of the SoA arrays (hyperlink ids, wrap flags and the cursor stay);
- GPU cell records: 16 bytes per cell in one persistent capacity-managed
  buffer (`glyph_id | attrs << 24`, then fg, bg and underline RGBA8 with
  inverse applied and faint as alpha 128), laid out for WGSL `unpack4x8unorm`;
- exact row dirtiness: rows Ghostty marks dirty but rewrites with identical
  content are compared word by word and not reported, so Ink-style redraws
  cost one native compare; stale records (first frame, resize, release, new
  glyph epoch) report full damage;
- per-terminal glyph interning (codepoint or grapheme content x bold x italic,
  dense ids from 1, capped at 16,384 with an epoch reset) delivered as a
  `[id][style][count][codepoints...]` stream, plus a visible blinking-glyph
  count so text-blink timers arm only when needed;
- viewport-independent buffer line reads (`restty_line_cells_*`) for word and
  line selection, block search and URL detection in either format;
- extended underline styles and colors, overline, inverse-aware decoration
  colors, text blink, graphemes, and wide-cell state;
- a raw `.wasm` asset instead of a multi-megabyte JavaScript string literal.

The bridge deliberately stays below Terax's model/surface boundary. Terax
retains renderer pooling, hidden-tab renderer release, damage-driven frame
scheduling, shell integration, semantic routing, and fallback selection.

## October 22 protocols

The bridge now lets Ghostty's own stream handler answer and report what it
already implements, through its effects (reply queue, size, colour scheme,
XTVERSION, OSC 9;4 progress), instead of answering only a hand-picked set:

- Kitty graphics: Ghostty's build disables the protocol on every freestanding
  target. `build.zig` turns the generated option back on, adds the wuffs
  import Ghostty wires only with the feature, and builds ghostty-vt from a copy
  of the pinned source whose image loader refuses the file, temporary-file and
  shared-memory media on freestanding targets before compiling their POSIX
  paths (only direct, in-band transmission is possible in a webview). PNG
  payloads (`f=100`, the default of most clients) are decoded by wuffs, which
  libghostty leaves to the embedder. Bulk APC payloads (`apc_put_slice`) reach
  the protocol parser; the per-byte path alone dropped every image. Placements
  follow Ghostty's renderer (pinned, relative and Unicode-placeholder virtual
  placements) and carry each image's generation for texture caching. Image
  storage is 64 MB per screen (`restty_set_image_storage_limit`).
- Mode 2048 in-band size reports on enable, on every resize (one report, with
  the current cell size) and on cell-size changes; mode 2027 grapheme
  clustering on by default and across RIS, like Ghostty's
  `grapheme-width-method = unicode`.
- Host-set colour scheme (DSR 996, mode 2031 change reports), visibility
  (DSR 998, mode 2033) and XTVERSION (`terax <version>`).
- Ghostty's mouse encoder for every tracking mode and format (X10, normal,
  button, any; X10, UTF-8, SGR, urxvt, SGR-pixels) with motion deduplication.
- Events for OSC 9;4 progress, OSC 22 pointer shapes and OSC 52 clipboard
  reads (answered by the host after asking the user; before, a read arrived as
  a write of `?`). OSC 21 Kitty colour queries are answered; OSC 4/10/11/12
  queries are answered once by Ghostty instead of by the bridge.
- Formatted range export as plain text, VT or HTML with soft wraps joined
  (`restty_text_range_format_prepare`), used to restore scrollback.
- Glyph interning applies Ghostty's renderer `constraintWidth`: a wide cell, or
  a symbol (`isSymbol`'s blocks and the Private Use Area) followed by an empty
  cell, a space or an en space that neither ends the row nor follows another
  symbol, gets glyph style bit 2 (`GPU_GLYPH_TWO_CELLS`). The renderer fits
  icons, symbols and emoji to that many cells, so a Nerd Font icon before a
  space is drawn at Ghostty's size.
- Ligature runs (`restty_set_ligatures`, on by default): 2 to 16 adjacent
  narrow cells of a row that each hold one ASCII punctuation or symbol code
  point with the same foreground (faint included), bold, italic and blink.
  Each cell is interned as the whole run with glyph style bit 3
  (`GPU_GLYPH_LIGATURE`) and its index in bits 4..7, so the renderer draws the
  font's contextual alternates (`->`, `!=`, `===`) across cells; longer runs
  continue as new runs. A run's cells get consecutive ids from one lookup, and
  a full table takes a run whole or not at all. Only punctuation is tested
  (one table lookup), so letters, digits and spaces keep the ASCII table path
  at its old cost (a 200x60 re-encode of plain text measured the same); a
  screen dense with operators costs about 1.6 times as much. Changing the
  switch re-encodes every row once, like a palette change. Runs break at the
  visible cursor, as Ghostty's run iterator does (`cursor_x`): a run ends
  before the cursor's cell, which is drawn alone. When the break moves, the
  rows it leaves and enters are re-encoded if its cell and a neighbour are
  candidates (Ghostty dirties a moving cursor's rows itself, not a cursor
  shown or hidden).
- Kitty clipboard (OSC 5522) through Ghostty's own protocol code, refused
  until the host sets a policy (`restty_set_clipboard_policy`). Ghostty's
  clipboard effects are synchronous and the host's clipboard is not, so the
  bridge holds a read (at most four; more are answered busy), reports it
  (`kitty_clipboard_read`: id, location, listing flag, the program's name and
  MIME types) and, when the host answers (`restty_kitty_clipboard_answer`),
  replays the packet through Ghostty with the answer, letting Ghostty encode
  the response (the reply queue may hold 48 MiB while it does, the base64
  framing of the 32 MiB the host serves). Turning reads off refuses those
  still held. Writes run Ghostty's write state machine (up to its 64 MiB) and
  reach the host as its first text and first `image/*` representation
  (`kitty_clipboard_write`: location, clear flag, then each MIME type with its
  data); one with neither is answered unsupported. Clipboard events (this and
  OSC 52) may carry Ghostty's write limit; other events stay within 256 KiB.
  OSC 52 stays the bridge's own, so Ghostty's handler never sees it.
- Mode 5522 paste events (`restty_kitty_paste_event`): for a user's paste
  from a clipboard the bridge mints Kitty's one-time password from host
  entropy (Ghostty's alphabet and rejection sampling; a freestanding target
  has no secure random source of its own), records the one-time read grant
  in Ghostty's handler and queues Ghostty's `PasteEvent`. A held read reports
  whether a grant covers it (peeked as Ghostty decides on replay: a named
  request for data, never a listing), and the replay consumes it. Declined,
  so the host pastes text, while reads do not go to the host.
- Kitty drag and drop (OSC 72): Ghostty's registration and acceptance state
  is reported (`drag_and_drop`) and queried (`restty_dnd_active`,
  `restty_dnd_accepted`); the host feeds native drags in with
  `restty_dnd_move`, `restty_dnd_drop` (up to 16 representations, served by
  Ghostty when the program requests them) and `restty_dnd_leave`.

## October 15 instance-per-terminal memory

A single shared instance can never give memory back: WebAssembly memory only
grows, so twenty agent tabs left the app at their joint high-water mark until
every model was gone. Each model now owns an instance of one cached
`WebAssembly.Module`. Measured on Node 24 with the `profile:ghostty` script and in a
real WKWebView on macOS 26 (footprint of the WebContent process):

- blank instance: 1,310,720 bytes before, 327,680 after (stack 1 MiB to 96 KiB;
  Ghostty needs at most 35,200 bytes on the adversarial soak below);
- one 120x40 terminal: 2,097,152 bytes before, 1,114,112 after; 20 blank
  terminals: 10,944,512 bytes shared, 22,282,240 private (the cost of isolation);
- synchronous instantiation of the cached module: 0.075 ms median in V8 (0.12 ms
  with the terminal) and 0.5 to 1.4 ms in JavaScriptCore (1 to 2 ms with the
  terminal in WKWebView, 1 ms timer resolution);
- open 20 heavy terminals (about 9 MiB of scrollback each), close 15: Node
  external memory 186 MB to 49 MB (shared instance: 175 MB to 174 MB); WKWebView
  footprint 247 MB to 73 MB, and 26 MB after the last close.

An idle WKWebView does not collect a dropped memory for many seconds, so the
loader creates a one-page `WebAssembly.Memory` 250 ms after a burst of disposals;
WebKit and V8 both collect when it is allocated (`reclaim` option). With the hint
the footprint is back within about a second (212 MB after one second without it).
`node scripts/ghostty-webkit-memory.mjs` repeats the WKWebView run.

Stack safety: `bun run soak:ghostty` writes about 33 MB of adversarial input per
artifact and render format (1 MiB OSC strings, 200,000-parameter SGR, nested
string introducers, DCS/APC/kitty floods, 100,000 combining marks, malformed
UTF-8, scroll-region extremes, reflow, search, selection, key encoding) with a
canary in the stack. The deepest use is 35,200 bytes (36%) in every artifact
and format; the soak and `GhosttyWasmStack.test.ts` fail above 50%. With the
4 KiB stack that was tried, the first write traps with a memory access error.

Known limits: JavaScriptCore keeps only eight instances on fast signal-checked
memory; instances past the eighth use explicit bounds checks and parse about
1.8x slower in a pure-parse microbenchmark (14.7 ms to 27 ms per 200,000 lines).
Calls from JavaScript into many different instances are polymorphic, which adds
about 0.4 microseconds to a write plus render-state update.

## October 14 upstream update

Both artifacts use the exact `main` revision above (141 commits after the
previous `7ec9e26a` pin). Terax continues to use its adapted bulk bridge; it does
not consume the mutable official nightly binary as a drop-in ABI. Upstream
changes that matter to Terax:

- use-after-free when scrollback pruning frees the page holding the cursor
  (ghostty-org/ghostty#14686), which long-running agent sessions that prune
  constantly would otherwise hit;
- grapheme preservation when a widening reflow wraps cells, DECSTR (soft reset)
  handling, and wide-character selection fixes;
- DECXCPR (`CSI ? 6 n`, answered `CSI ? row;col;1 R`) and `CSI 19 t`
  (`CSI 9;rows;cols t`) were added to upstream's device-status and size-report
  enums. The bridge's exhaustive switches required matching replies in
  `terax.zig`; no other bridge behavior changed.

Linear memory is unchanged from the previous pin: 20 blank 120x40 models use
10.4375 MiB, and the block-enabled stress workload plateaus at 68.1875 MiB for
both variants with zero plateau growth. Artifacts grew by 4,099 (SIMD) and 4,172
(scalar) bytes. This source update is not claimed as an application CPU or RAM
saving. Native canvas reuse and row-staging measurements are recorded separately
in `docs/architecture/ghostty-resource-efficiency.md`.

The GPU cell-record format (`TERAX_SOAK_FORMAT=gpu`, `TERAX_PROFILE_FORMAT=gpu`)
keeps the blank allocation and plateaus 786,432 bytes lower (67.4375 MiB) with
zero plateau growth. The format added about 16 KiB to each artifact.

## September memory regression gate

The September 7 pin includes upstream page allocation, default-palette sharing
and fixed terminal allocation reductions. There is no tagged stable standalone
libghostty WASM release in the inspected release list; Terax still builds its
adapted bridge from an exact source revision, rather than consuming the nightly
artifact or treating Ghostty's application version as a stable library ABI.

The update alone saved only one 64 KiB WASM page across 20 blank 120x40 models.
With Terax's lazy presentation arrays, the identical workload uses 10,878,976
bytes instead of 16,187,392 bytes at `0e3fae9`, a 5,308,416-byte reduction.
Isolated per-artifact row-edit, scrolling and OSC microbenchmarks were within
roughly 2% of baseline; this is not evidence of an application CPU speedup.
See `docs/architecture/ghostty-resource-efficiency.md` for reports and limits.

The allocator rebase was measured against the previous pinned artifact with an
identical five-terminal, approximately 16 MiB-per-terminal ASCII workload.
Total WASM linear memory after the workload fell from 20,119,552 bytes to
8,978,432 bytes. The current tests also gate fresh multi-terminal allocation,
adjacent resize stability, oversized transient release, and a three-terminal
Unicode-heavy agent workload. These measurements cover linear memory only;
process RSS and GPU allocations are separate release gates.

## Rebuild

From `packages/ghostty-core/adapted/wasm` (add `-Dwasm-stack-kib=N` to change the
96 KiB shadow stack; `bun run soak:ghostty` reports the deepest stack use):

```sh
zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
cp zig-out/bin/terax-ghostty-vt.wasm ../ghostty-vt.wasm
zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast -Dwasm-simd=false
cp zig-out/bin/terax-ghostty-vt.wasm ../ghostty-vt-scalar.wasm
shasum -a 256 ../ghostty-vt.wasm ../ghostty-vt-scalar.wasm
```

`build.zig.zon` pins both the Ghostty archive URL and Zig package hash. A
checksum change must be reviewed together with the source revision and the
terminal compatibility and resource gates.

Both variants run the same adapted-core regression suite. The Rust integration
test `ghostty_artifacts` additionally validates the scalar binary with SIMD and
relaxed SIMD disabled and confirms that the primary binary requires SIMD.
`bun run bench:ghostty` compares both variants at the same source revision; those
measurements exclude IPC, webview presentation, process RSS, and energy.
