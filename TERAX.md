# TERAX.md

Terax loads `TERAX.md` from the workspace root as agent memory (similar to AGENTS.md / CLAUDE.md). This file is also the project's living architecture doc - read it before making changes.

## Project

**Terax**: open-source AI-native terminal emulator. Tauri 2 + Rust (`portable-pty`) backend, React 19 + TypeScript + libghostty-vt WASM client (WebGPU, Terax WebGL fallback), BYOK AI via Vercel AI SDK v7.

- Bundle id: `app.crynta.terax`
- Package manager and runtime: **Bun** (`bun install`, `bun run <script>`). `bunfig.toml` runs scripts and their tools on Bun rather than Node, keeps a three-day minimum release age, and uses the isolated linker so undeclared dependencies fail
- Platforms: macOS, Linux, Windows
- Frontend checks: `bun run lint`, `bun run check-types`, `bun run test`
- Rust checks: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (local fallback: `cargo test --locked`)

## Quality bar

Production-grade or it does not ship. Every change is judged against all of these, not just "it works":

- **Correctness**: edge cases, failure modes, concurrent access. No "works for now".
- **Performance**: ultra-lightweight is the product. ~7-8 MB bundle, high-performance terminal. For every change ask: how much RAM it costs, whether it adds IPC round-trips or redundant requests, whether it triggers extra re-renders or wasted work, whether it pulls a heavy dependency. Unused features consume zero resources.
- **Security**: no critical security holes. Validate at every boundary (IPC, fs, network, AI tool surface). The secret-path deny-list applies on both read and write and is never bypassed.
- **UI/UX**: polished, professional, premium. Every state and detail considered.
- **Architecture**: new or changed logic lives in pure, dependency-light functions (functional core); tauri commands and React components stay thin (imperative shell). Keeps it testable without a later rewrite.

Verify before claiming done:

- Frontend: `bun run lint`, `bun run check-types`, `bun run test`
- Rust: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (or `cargo test --locked`)

A change to a core subsystem (terminal/shell spawn, workspace auth, git, fs, IPC or AI tool surface) needs a test that locks the invariant.

## Terminal migration status

libghostty-vt is the only terminal model. WebGPU is the default renderer and
Terax WebGL is the compatibility fallback. Each leaf owns one persistent model
in its own WebAssembly instance (the module is compiled once and shared), so
closing a leaf drops its linear memory and scrollback instead of leaving a
high-water mark; nothing may retain a view into a disposed model's memory.
Scrollback summed over all leaves is capped by a budget (192 MiB, scaled fairly
between leaves, never pruning history already held). Presentation resources are
shared, bounded, and released for hidden leaves.
All visible WebGPU panes of a window draw into one canvas that covers the
terminal area (`gpu/WebGpuWindowCanvas.ts`; the `[data-terminal-area]` layer of
`TerminalStack`, behind the tab layers). Each pane renders into its device-pixel
snapped rectangle (`gpu/PaneRects.ts`, measured on layout changes only) with
`setViewport` and `setScissorRect`, which keeps glyph overhang out of the
neighbour; the shader takes viewport size and origin from the uniform, so a
pane's pixels equal what a canvas of its own showed (verified byte for byte,
`scripts/terminal-visual/grid.html`). Canvas textures are not preserved between
frames, so a window frame clears the canvas and encodes every visible pane in one
pass (cell buffers stay resident on the GPU, no per-cell work). Per-pane dirty
tracking still decides whether a frame is needed: an unchanged window acquires
no texture (`windowFrameNeeded`). `SurfaceFramePacer` decides which panes prepare
in a frame; a pane whose rectangle moved always does. Pane DOM is transparent
once the canvas has shown the pane's first frame (until then it paints the theme
colour, so a tab switch never flashes the card behind); scrollbars, selection,
IME, block overlays and cursor styles stay per-pane DOM above the canvas.
A presented WebGPU canvas is never destroyed, unconfigured, shrunk or
dropped while the runtime lives: WebKit (macOS 26) keeps the swapchain of such a
canvas in the WebContent process for good (three buffers, about 30 MiB for a
2000x1300 canvas, whatever the teardown order and garbage collection), and keeps
every swapchain a resizing canvas retires until JavaScriptCore collects its
wrappers (minutes), so every teardown or resize leaks. A tab switch, a split or a
divider drag therefore only changes viewports: zero canvas allocations. The
canvas is reallocated only when the terminal area itself changes size, at most
twice per window drag (below). With no visible pane (an editor tab is active) or
an occluded window it is paused (hidden after a short delay when empty), never released. A replaced or
recovered GPU device reconfigures the same element, and a remounted area takes
over the old one's canvas. Only disposing the runtime tears it down. The WebGL
fallback stays per pane (its own canvas and opaque background inside the pane
root): a WebGPU failure in one pane falls that pane back, and a failure of the
shared runtime falls every pane back.
Every submitted window frame is mirrored to JavaScriptCore (`gpu/GcPressure.ts`):
the wrappers of a frame (texture, view, encoder, pass, command buffer) pin about
13 KiB of WebKit malloc that JavaScriptCore does not count, so without help it
collects them after minutes (20 MiB a minute for a streaming agent). Allocating and
dropping a 126 KiB `ArrayBuffer` per frame (ten times the native cost; measured:
unfinalized canvas textures after 120 s 2,626 without, 195 with it, no change in
instructions per second) makes young-generation collections run steadily. At most
4 MiB a second is mirrored, so display-rate frames allocate no more than a 25 fps agent.
Resizing applies one synchronized model + PTY resize per gesture. Every SIGWINCH
makes zsh/fish and Ink-based agents redraw, and redraws that do not line up with a
reflowed grid leave duplicates in scrollback, so during a resize gesture (native
macOS live resize via `NSWindowWillStart/DidEndLiveResize`, forwarded as
`liveResize` in `terax:window-presentation`; a pane divider drag via
`terminalResizeInteraction`; elsewhere a burst of size changes less than 150 ms
apart, `lib/terminalResizeGesture.ts`) neither the model nor the PTY changes. The
pane follows the pointer at display rate (`SurfaceFramePacer` gesture mode) and
draws its existing grid: shifted up (`shift_y`) so the cursor row stays visible
when the pane is shorter, clipped on the right or padded with the background
otherwise. At release `TerminalResizeSync` resizes the model and tells the PTY in
one call, model first. Ghostty clears the prompt on that resize and relies on the
shell's redraw, so the pane holds its previous frame until the redraw ends or
70 ms pass (`core/ResizePromptHold.ts`; only at an OSC 133 prompt, never in the
alternate screen). Resizes outside a gesture (sidebar, font, ratio, first fit,
showing a hidden pane) apply at once. During a gesture the window canvas's backing
store is grow-only: it keeps its allocation while the area shrinks and, when the
area outgrows it, allocates once to the largest size it can reach
(`gpu/GestureBacking.ts`: the area plus the screen room left when the window
itself is dragged, else the window; capped by the device limit), then compacts at
release, so a drag costs at most one growth and one compaction. The WebGL
fallback defers the same way per pane (top-anchored).

The WebGPU path (renderer v2, `docs/architecture/terminal-renderer-v2.md`) runs
no per-cell JavaScript. Ghostty encodes 16-byte cell records natively and
reports only rows whose bytes changed. The surface uploads those ranges straight
from WASM memory (`consumeGpuFrame`) into a storage buffer, and nothing may call
the model between that frame and the upload because the view is borrowed. It
never touches the structure-of-arrays APIs, which would flip the model's format;
only the WebGL fallback uses them. A background pass derives each cell from its
pixel (background, search, selection, cursor, decorations) and an instanced
glyph pass draws integer-pixel quads with unfiltered `textureLoad`. Selection and
cursor are uniforms and the search highlight is a mask buffer that exists only
while something is highlighted, so none of them rewrites cell records.
Geometry is pixel exact. Fonts are measured at size times ratio and cells are
whole device pixels (`TerminalFontMetrics.deviceCell*`). `cellWidth` and
`cellHeight` are the CSS size, device divided by ratio, and are what fit,
hit-testing, selection, links and block overlays use. The fit leaves the
scrollbar strip on a pane's right edge (11 px, `TERMINAL_SCROLLBAR_WIDTH`) out of
the grid, so the last column is never under the strip, which takes the pointer
there, and text keeps a gutter from the pane's edge. A pane's rectangle in the
window canvas holds at least cols by rows device cells (slack is background, the
scissor clips the rest) and the canvas origin is translated onto the device
pixel grid when the observer, ratio or window size changes. A ratio change
re-measures the font and rebuilds atlas and buffers.
Each terminal maps Ghostty glyph ids to a glyph atlas shared per font and ratio.
The atlas grows (coverage 1024 to 2048 to 4096, colour 512 to 2048) before it
flushes into a new epoch; after a flush each surface rescans its visible cells and
re-rasterizes only what it shows. Rasterization is limited to about two
milliseconds per frame across surfaces, leftover glyphs draw on follow-up frames,
and a backlog from scrolled-away output keeps only visible glyphs queued.
Grayscale text gets a DirectWrite-style contrast curve when the ratio is below 2
or on Windows and Linux (`localStorage["terax:terminal-text-contrast"]` is
`off`, `on` or a strength); macOS Retina is unchanged.
Box drawing, block elements, braille, powerline separators, git branch drawing
(U+F5D0-F60D) and legacy computing shapes including the supplement (octants,
separated sextants and quadrants, sixteenths, circle pieces) are drawn
procedurally at exactly the cell size, not from the font, with Ghostty's sprite
geometry (`gpu/BuiltinGlyphs.ts`, pure, shared by the WebGPU and WebGL atlases;
every code point Ghostty's sprite font draws, checked against its reference
images), so borders and bars join seamlessly at every size and ratio. They
ignore bold and italic and skip the text contrast curve. Font glyphs that are
not plain text are fitted to their cells with Ghostty's constraint maths
(`gpu/glyphConstraint.ts`): Nerd Font icons get Ghostty's per-icon size and
alignment (`gpu/nerdFontConstraints.ts`, generated by
`scripts/nerd-font-constraints/build.ts` from the pinned Ghostty's table), other
symbols shrink to fit, and emoji fill their cells. A glyph gets two cells by
Ghostty's cell rule: a wide cell, or a symbol followed by a free cell or a
space that neither ends the row nor follows another symbol (the core marks it
with `GPU_GLYPH_TWO_CELLS` for WebGPU; WebGL applies `constraintCells`). Text is never
transformed. One rasterizer (`gpu/GlyphRasterizer.ts`) serves both atlases.
Glyphs are drawn in white; one with coloured pixels is drawn again in black and
is a colour glyph (drawn with its own colours, not the cell's) only if it
keeps them, since subpixel antialiasing (WebKitGTK on an LCD-rendering desktop)
fringes plain text with colour (`gpu/glyphColor.ts`).
Font ligatures (Settings, "Font ligatures", on by default, off while letter
spacing is set) use runs of 2 to 16 adjacent narrow ASCII punctuation cells
drawn alike (`gpu/ligatureRuns.ts`; the core interns each cell as the whole run
plus its index, `GPU_GLYPH_LIGATURE`, and WebGL applies the same rule): every
cell's glyph is the run drawn with that cell's character on its pen origin, cut
to the cell, so `->` or `!=` joins while each cell keeps its own pixels.
Runs break at the visible cursor, as in Ghostty, so the text under it reads as
typed; the rows the break moves between are re-encoded.
Font features (Settings, "Font features": `zero, ss01, -calt`, Ghostty's
`font-feature` syntax; `terminal/lib/fontFeatures.ts`) ride on the font faces,
since canvas text has no `font-feature-settings`: each `@font-face` family of
the terminal stack is declared again under a derived name through `FontFace`
with `featureSettings`, and the stack (grid and block editor) names that
instead. Installed fonts (Nerd Fonts) ahead of the bundled one are declared
again from their face files: `system_font_faces` (`fontdb`, rescanned at most
every 10 s when a family is missing) lists a family's faces, and each loads
through the asset protocol the first time it is drawn (`local()` cannot name
faces reliably). Collection members past the first are skipped. Until the
lookup answers the font draws as named, then the panes measure again. On macOS
installed families take this path with no features too: WKWebView's canvas
does not see fonts the user installed and draws a fallback, so a configured
Nerd Font never reached the grid; macOS's own fonts (under `/System`) still
draw by name.
Letters, digits and spaces never form runs and keep the ASCII fast path.
Kitty graphics draw in both renderers in Ghostty's three layers (under cell
backgrounds, between backgrounds and text, above text; `gpu/imageLayer.ts`,
pure and shared). The image code loads the first time a pane shows an image
(`WebGpuImageLayer.ts`, `webgl/WebGlImageLayer.ts`). Each image is one RGBA
texture keyed by id and re-uploaded only when its generation changes; a pane
holds at most 64 MiB and 256 textures, an image off screen keeps its texture
for 60 updates, eviction takes the least recently shown off-screen images
first, and everything is freed when the pane hides or loses its device.
Animations tick right before a frame reads the model with one timer armed for
the next frame change, and none while the pane cannot be seen
(`gpu/imageAnimation.ts`). The hovered link (OSC 8 or detected) gets an
underline overlay in the text colour; cell data is never rewritten for it
(`gpu/linkUnderline.ts`).
A custom shader (Settings, General, Terminal; Ghostty's and Shadertoy's
`mainImage` contract with Ghostty's uniform names, `iChannel0` the finished
frame, `iCurrentCursor`/`iPreviousCursor`/`iTimeCursorChange` for trail shaders)
runs on the WebGL renderer, which terminals use while one is set
(`webgl/customShader.ts`, loaded on first use): the frame is drawn into a texture
and the shader draws the canvas from it, as WebGL2 GLSL (Shadertoy's dialect).
Settings compiles a chosen file before saving it and shows compiler errors by
line; it animates only while the window has focus.
Native cell, grapheme and hyperlink presentation buffers allocate on first use
and return to the WASM allocator when a pane is hidden. Hidden parsing does not
rebuild them. Window pauses (occlusion, sleep) retain them and the uploaded cell
data.
Unchanged frames do not acquire presentation textures or draw; cursor-only
updates upload only the uniform. WebGL background and decoration geometry uses
row range uploads while rectangle counts are stable; structural changes rebuild
the compact stream. Scrollbar synchronization never reads the DOM on presented
frames; moving the thumb under a bottom-pinned view costs at most ten position
writes and four ARIA updates a second. Blink timers stop in unfocused windows,
and native cursor hiding stops cursor timers. Selection is a uniform and needs no
row damage; streaming search invalidations coalesce instead of rebuilding per
output chunk.
WebGL surface and renderer code load only when selected, needed for fallback,
or explicitly requested by diagnostics. On Linux a WebGL context keeps its
drawing buffer (`webGlContextAttributes`): WebKitGTK without hardware
acceleration (NVIDIA on Ubuntu) paints the canvas from the buffer it just
swapped out, so every frame, the last keystroke included, showed one late. Delayed imports cannot install into a
closed, restarted, or replaced session.
xterm, its addons, CSS, snapshots, session pool, and dormant byte ring are removed.
Unsupported graphics produce a visible error with retry instead of changing models.

Command blocks use parser-time Ghostty tracked pins, including endpoint columns,
so command ranges survive reflow and exclude following prompts and commands.
The native marker ring is capped at 2,048 pins; JavaScript history is capped at
1,000 blocks and 512 KiB of estimated UTF-16 command/cwd text. Block implementation
and UI load only for block sessions, and hidden/occluded block presentation stops.
Block search yields after 128 rows or four milliseconds, retains at most 500
matches, and cancels obsolete queries. Block copy, search, sticky headers, navigation, Ask AI, rerun, shared shell input,
and selection all use the same persistent Ghostty model.
Block chrome commits with its matching renderer frame; it is recomputed only when
the viewport origin, scrollback, size, cell height, block mode or block set
(`GhosttyBlocks.revision`) changed, so frames that only repaint cells cost no
block work and no React commit. The per-frame path reads cached cell metrics, never
layout, and the shell/prompt input switch runs on block-mode changes, not per PTY
chunk. Command-editor focus does
not lower active-pane cadence. Divider padding is presentation-only and does not
change copied command boundaries. Scrollbars preserve native fractional positions
and ignore delayed programmatic scroll events. Hidden output does no surface DOM
or search-mask work until presentation resumes.

Terminal clipboard shortcuts use the native text clipboard plugin on all desktop
platforms. The keys are one pure decision (`terminalClipboardAction` in
`terminal/lib/keymap.ts`): Cmd+C/V on macOS; Ctrl+Shift+C/V, Ctrl+Insert and
Shift+Insert elsewhere; and on Windows, like Windows Terminal unless Settings
turns it off (`terminalBehavior.smartCopyPaste`), Ctrl+C copies and clears a
selection (interrupting without one) and Ctrl+V pastes text, or reaches the
program when the clipboard holds no text so agents can read an image. Linux
keeps plain Ctrl+C/V for the program. When the clipboard holds only an image,
the other paste keys (Cmd+V, Ctrl+Shift+V, Shift+Insert) send the program
Ctrl+V in its keyboard mode, so agents such as Claude Code and Codex read the
image themselves; a program that set mode 5522 gets the Kitty paste event
listing `image/png` instead. A copy key with nothing selected goes on
to the program. Context clicks expose the selected text through the input element to
restore the webview's native text menu; no persistent DOM scrollback is maintained.
On macOS the input `<textarea>` always holds one selected placeholder character
(`TerminalInputProxy`; elsewhere it stays empty, a selection could take X11 PRIMARY): a focused editable with a collapsed selection keeps
WebKit's caret animation (a display link at display rate) running at ~3 % CPU and
~250 wakeups/s while idle, a non-collapsed selection paints no caret (0.2 %, ~10/s).
It re-arms after input, key release and focus, never during IME composition, and
native Copy/Cut without terminal text must not copy the placeholder.
Unclaimed macOS Command shortcuts reach the native menu after explicit clipboard,
block-editor, and readline bindings, including when Kitty keyboard mode is active.
The block prompt retains an enabled terminal input proxy for native menus and
routes editing keys, composed text and paste back to its command editor.
Character drags retain a native selection pin from pointerdown, including before
the first pointermove. Unmoved clicks and lost captures discard provisional pins.
A drag whose release never arrived ends at the first move without the
primary button, where the pointer last was.
Key encoding supplies the base character required by Kitty keyboard mode; plain
keys and key releases also use Ghostty encoding when the application requests it.
Shift that picked a key's typed character is passed as consumed, as Ghostty's
own apprts do, so Kitty modes below report-all send the text (Shift+; is `:`)
and report-all names the unshifted key with Shift. Shift+Enter is ESC CR (what
agents read as a newline) unless the program set Kitty keyboard flags or
modifyOtherKeys 2, which get Ghostty's encoding (`CSI 13;2u`). On Windows a
program cannot turn on Kitty report-events or report-alternates
(`supportedKittyKeyboardFlags`, applied by the core to every push and set, so
queries report what is in force): the inbox ConPTY drops any input CSI with a
`:` sub-parameter, which those flags put in arrows, releases and shifted keys.
Caps Lock and Num Lock are reported with every key, as Ghostty and Kitty do;
programs speaking the protocol mask them.
Keydowns an input method owns (during a composition, dead keys, keyCode 229
on character keys) are left to the webview, whose input and composition
events carry the text (`isInputMethodKeyDown`); arrows, Home, End, Page keys,
Backspace and Delete stamped 229 (WKWebView's Option keys) are still keys.
Text one keystroke delivers twice by different events (a prevented keydown
and a stray `beforeinput`, `compositionend` and `insertText`) is typed once;
the pairing ends at the next keydown, so a fast double letter always types.
Terminal text uses the configured font, an installed Nerd Font when detected,
or bundled JetBrains Mono: the official variable fonts, upright and italic, with
every glyph, weight (100-800) and OpenType feature, split by Unicode range into
WOFF2 segments (`src/styles/jetbrains-mono.css`, regenerated by
`scripts/jetbrains-mono/build.ts`); `ensureMonoFontsLoaded` loads the Latin
segment of each style before a terminal starts and the rest load on first use.
Engines never fall back to unnamed fonts for Private
Use Area codepoints, so every stack ends its chosen fonts with "Terax Symbols":
Symbols Nerd Font split into one WOFF2 per icon set (`src/styles/symbols.css`,
regenerated by `scripts/symbols-font/build.ts`). Its faces cover only the
Private Use Area, so a segment downloads the first time one of its icons is
drawn and ordinary text never touches it; an installed Nerd Font earlier in the
stack still draws its own icons. Glyph atlases must not cache a glyph drawn
before its font arrived: `GlyphFontGate` defers every non-ASCII glyph (icons,
and text in a JetBrains Mono segment not loaded yet) until `document.fonts`
reports its fonts loaded (a failed load also settles), the
WebGPU glyph map parks them outside the raster queue and the WebGL renderer
redraws in full when the load settles. Icons, like procedural glyphs, ignore
bold and italic. Native color emoji remain on the system fallback path. Rerun requires the complete command
submitted through Terax; truncated shell labels are never executed.
Primary-screen full erase, scrollback erase, and terminal reset invalidate block
pins at parse time and clear block chrome, selection, and search. Commands after
an erase in the same output chunk retain their new pins. Alternate-screen erases
preserve primary block history. Block scrollbar status dots are removed along
with their timers and history scans.

The shared command bar activates after shell integration confirms prompt input.
Bare shells keep direct terminal input. Bash before 4.4 reports
`OSC 133;B;terax_blocks=0` and keeps its native prompt because it lacks PS0.

Settings offer Automatic or WebGL for new terminals, plus opt-in screen reader
output. Accessible text is limited to 256 rows / 64 KiB and refreshes at most four
times per second while visible. Ordinary URL detection runs on pointer demand;
OSC 8 links take precedence. A clicked link opens in the browser (URLs), the
editor (files, at their line) or the system file manager (local folders); a
file:// link counts as local with no host, `localhost` or this machine's name,
which `ls --hyperlink` and eza write (`terminalLinkOpen.ts`). OSC 52 side effects retain one in-flight write and
only the latest pending value across the window. OSC 52 writes carry up to
6 MiB of text (about the 8 MiB of base64 Ghostty takes per OSC) and reads are
answered with up to 8 MiB. Terminal replies have a PTY budget of their own,
apart from what the user types: one larger reply (up to 64 MiB, a clipboard
answer) is taken while no backlog beyond it is queued.

Kitty clipboard reads (OSC 5522) follow the clipboard-read setting: denied ones
the core refuses itself, others are held in the core until the user answers
the same prompt OSC 52 uses (naming the program as it names itself) and then
answered with the clipboard text under each requested text type and the
clipboard image as `image/png` (32 MiB at most per answer, all types
together); a listing of the types on offer is served unasked, as Kitty does.
The image is read and encoded only when asked for or listed, and reads within
a second share one. A program that sets mode 5522 is told of a paste from a
clipboard (shortcut, menu, middle click) by a Kitty paste event instead of the
text, listing `image/png` too when the clipboard holds an image (a clipboard
holding only an image is pasted this way alone), and its follow-up read,
covered by the event's one-time password, is served without the prompt.
Writes are allowed like OSC 52 writes and share its latest-value queue (the
primary selection, text only, where asked); a write with an image puts the
image on the clipboard (types other than PNG converted through a canvas), its
text written instead should the image not decode. Files dragged over a pane whose program registered for drops (Kitty
OSC 72) go to the program as a copy, offered as `text/uri-list` and
`text/plain`; elsewhere a drop pastes shell-quoted paths as before.

The adapted Ghostty revision is pinned in `packages/ghostty-core/adapted/UPSTREAM.md`.
Both SIMD and scalar artifacts are shipped; the loader fetches only the variant
the webview supports. Scalar validation explicitly disables SIMD instructions
and types. This avoids changing OS minimums solely for the WASM SIMD requirement;
actual older WKWebView and WebKitGTK compatibility still needs platform tests.

PTY output is one multiplexed pull stream per window (`docs/architecture/pty-transport-v2.md`),
not a channel per terminal. The async `terax-pty` URI scheme (`pty/protocol.rs`) has two POST
endpoints: `poll`, kept outstanding exactly once per webview, and `ack`. One process-wide hub
thread (`pty/hub.rs`, scheduler in plain data driven by explicit time) holds the poll's responder
and answers with framed binary data (`pty/wire.rs`: `[u32 id][u8 kind][u32 len]`, kinds data, exit,
failed, sync; data frames carry their stream offset; responses are capped at 1 MiB) for every
terminal whose coalescing deadline is due. A terminal's presentation class picks its deadline:
focused 4 ms (16 ms sustained), visible 16 ms, hidden 100 ms, window occluded or asleep 250 ms;
256 KiB pending is always due, and terminals due within 4 ms ride in the same response (one
terminal contributes at most 512 KiB per response, so floods pipeline and share). The
frontend reports classes only on change (`pty_set_presentation`, from `lib/ptyPresentation.ts`);
each report carries a growing sequence number and a terminal keeps the newest one that named it,
because async commands can be applied out of order. macOS occlusion and sleep reach the hub natively
from `window_presentation.rs`, per window (each app window's own occlusion and live resize, sleep
for all of them). The stream token from `pty_stream_open` is the credential: any frame
can reach the scheme but only the page can invoke, so every request is admitted (`pty/gate.rs`) on
the handler's thread before it may wake the hub: the `Origin` must be the app's own
(`tauri://localhost`, `http(s)://tauri.localhost` on Windows, the dev server in dev builds; a request
without `Origin` is token-only), the body at most 3084 bytes (413) and well framed (400), and the
token the live one for the requesting webview (403; the hub publishes label to token, compared in
constant time). Responses echo the allowed origin with `Vary: Origin`, never `*`. Tokens come from OS
entropy only: if it fails, `pty_stream_open` fails instead of falling back to the clock. A terminal's
output is held until its receiver announces itself, and reload or window
destruction drops the held responder, kills the token and detaches that window's terminals.
Frontend `PtyOutputHub` owns the loop: it re-polls on a response before parsing and demultiplexes
to the `PtyOutputReceiver`s, whose cumulative parsed offsets ride on the next poll. An ack-only
request goes out only for new receivers, for more than 512 KiB of unsent progress, or when native
sends `sync` because it waits on that terminal (credit blocked or exiting).

Receivers parse in at most 32 KiB slices with a four-millisecond work budget on a shared FIFO
MessageChannel task queue, which closes its ports when idle. Only fully parsed original chunks
earn credit. Credit is bytes: at most 1 MiB in flight (128 chunks) and 2 MiB pending plus in
flight per terminal. Acknowledgments are cumulative offsets validated against delivered chunk
boundaries, so duplicates and retries cannot grant credit; a bad boundary or stream gap fails only
that terminal visibly. Parser failures stop delivery without acknowledging unconsumed bytes.
Transport failures retry with capped backoff and surface as one stalled/failed toast per
terminal. Exit waits for the reader drain and the final acknowledgments; the `exit` frame always
follows that terminal's last data frame. Unix readers sleep on PTY readiness plus an explicit
shutdown signal without a polling timer. After shell exit they consume ready output, bounded to
2 MiB / 30 seconds, rather than wait indefinitely for an inherited slave descriptor to close.
Exceeding this drain bound reports a reader failure and exit status -1. After shell exit,
30 seconds without acknowledgment progress closes a stalled queue with a logged delivery failure
and exit status -1. The deadline is armed before ConPTY close and thread joins; it does not run
during live-shell backpressure. Close wakes blocked queue workers and the Unix reader; Windows
keeps draining the pipe while ConPTY closes. Per-read costs stay low: the agent and DA filters
scan with `memchr` and copy runs, the reader checks an atomic `closed` flag and reuses its
buffers, input goes through one bounded queue to a per-session writer thread, worker threads use
128-256 KiB stacks, and `pty_has_foreground_process` lists children with `proc_listchildpids` or
`/proc/<pid>/task/*/children` instead of forking `pgrep`.

Enable release diagnostics with `localStorage.setItem("terax:terminal-diagnostics", "1")`
and reload. `window.__teraxTerm()` reads frontend counters;
`await window.__teraxTermSnapshot()` adds native queue counters and explicitly
labeled host RSS. Host RSS
excludes WebContent and GPU processes and is not total application memory.

Ghostty presentation uses shared native macOS occlusion/sleep and DOM visibility
tracking. Every renderer pauses immediately. The WebGPU renderer does nothing
more: frames and timers stop, while the window canvas (configured, at full size), cell
buffers, glyph maps and atlas textures stay resident, so coming back from a
Space switch, minimize or sleep costs one redraw and no allocation. Releasing
them is worse than keeping them (see the window canvas above). The WebGL fallback
still reclaims its renderer after two seconds of continuous occlusion, and at
once on sleep, because its dropped canvases are garbage collected (measured:
transient, no growth). Hidden tabs release their buffers and atlas lease immediately and
leave the window canvas (its size is kept). Per-pane pacing prevents focused output from
raising background pane cadence. Panes that are neither focused nor being
interacted with snap to one shared tick (30 Hz, 15 Hz in an unfocused window):
a pane that turns dirty waits for the end of its tick and presents with every
other pane of that tick in one encoder, submission and commit, at most once per
tick. The planner asks for an animation frame only for the vsync that can serve
the next deadline (the refresh interval and phase are learned from callback
timestamps), sleeping on a timer otherwise, so a 120 Hz display does not pay a
callback per vsync. A timer sleeping for a later tick is re-planned when a pane
that is due sooner turns dirty, so the focused pane never waits behind it.
WebGPU permits at most two outstanding frame submissions and keeps one
`onSubmittedWorkDone` wait outstanding at a time: frames submitted while it is
pending ride the next wait, which starts when it resolves (waiting only every
second frame was tried and cut a 32 Hz producer to 23 presented frames a second).
User wheel, drag, and keyboard interaction gives only its pane 150 ms of focused
cadence, including in an unfocused visible window. It starts no idle timer or
frame loop.
`window.__teraxTermTrace()` explicitly starts a bounded ten-minute resource trace;
it is never started automatically. `bun run soak:ghostty` exercises real WASM models
without launching the application. `bun run profile:ghostty` compares allocation
and parsing workloads in a fresh process per artifact and optional baseline.
`bun run profile:renderer:macos` exercises the real renderer in an isolated native
WKWebView, including optional four-pane layouts and live visual inspection.
`scripts/terminal-visual` draws a fixed pattern through any source tree and reads
the canvas back as exact pixels for comparison.
`bun run test:ipc:macos` verifies binary AI streaming, cancellation, and conversation
storage in a separate Tauri profile with synthetic local HTTP responses.
Resource evidence and limitations live in
`docs/architecture/ghostty-resource-efficiency.md`.

The release gates and current verification evidence are in
`docs/architecture/ghostty-release-readiness.md`. Automated checks alone do not
establish production readiness, platform parity, or multi-day resource stability.

## Conventions

- **Comments**: default to none, the code should explain itself. If genuinely needed, 1-2 lines on *why*, never *what*. No AI-generic filler.
- **No em-dash** anywhere: code, comments, commits, docs.
- **No emojis** anywhere.
- **Encoding**: text files are UTF-8 without a byte-order mark. Write control characters as escapes (`\x00`), never as raw bytes: one raw byte makes git and ripgrep treat the whole file as binary. `src/app/source-encoding.test.ts` enforces both.
- **Imports**: always `@/...` on the frontend, never relative across modules.
- **Bun only**, never npm/npx/pnpm/yarn. Invoke package binaries through `bun run <bin>` (`bun x` does not apply `bunfig.toml`'s `[run]` settings and falls back to Node).

## Architecture

### Two-process model

**Rust (`src-tauri/`)** owns all OS access. The webview never touches the FS, processes, or shells directly - everything goes through `invoke()` calls to commands registered in `src-tauri/src/lib.rs`:

- `pty::pty_*` - long-lived interactive PTY sessions (portable-pty ↔ Ghostty), managed by `PtyState` (`RwLock<HashMap<id, Session>>`). Output streams over the `terax-pty` multiplexed pull stream (hub thread, `pty_stream_open`, `pty_set_presentation`); input goes through a per-session writer thread.
- `fs::tree::*` (`fs_read_dir`, `list_subdirs`), `fs::file::*` (`fs_read_file`, `fs_write_file`, `fs_stat`, `fs_canonicalize`, `fs_open_default`, `fs_host_path`: the host path a WSL file is read through, for asset URLs), `fs::mutate::*` (`fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_move`, `fs_delete`, `fs_delete_batch`), `fs::copy::fs_copy`, `fs::clipboard::fs_clipboard_paths`: file explorer + editor IO. `fs_write_file` replaces a file atomically (temp file in its folder, then rename) and writes through a symbolic link to its target, keeping the link and the target's permissions; a dangling link is an error, never a new file. `fs_open_default` (Open in Default App in the explorer and its search) hands the OS only an existing file whose real path lies in an authorized workspace. File paste captures the workspace and root before clipboard IPC. AppKit and GTK clipboard requests run on the main thread; Windows clipboard retries and filesystem copies run on blocking workers. `fs_copy` requires an authorized root, stages each item and publishes with a no-replace rename, and returns `{ created, failed }` with paths in the caller’s workspace representation. Conflict renaming uses `name copy N` siblings. Symbolic links are preserved without traversing them; copying a folder into itself is rejected. Explorer refresh and pasted selection ignore completions from an obsolete workspace.
- `fs::search::*` (`fs_search`, `fs_list_files`), `fs::grep::*` (`fs_grep`, `fs_grep_interactive`, `fs_glob`): fuzzy file finder + content search (powered by `ignore` + `grep-*` crates). File lists are cached per root in `fs::index` (packed buffer, at most two roots, 45 s TTL) and dropped by watcher events and our own mutations, so a keystroke ranks the cached list instead of re-walking the tree (a change reported during a cold walk marks that walk stale: its result is returned but not cached). Interactive searches bump a `fs::supersede` generation when the command is dispatched, so the walk of an older query stops while a newer one starts. Every command that touches the disk is `async` and runs on the blocking pool (`fs::blocking`): Tauri runs a plain command on the main thread, and the async runtime has two workers (`modules/runtime.rs`), so nothing blocking may run inline in an `async fn` either.
- `git::commands::*`: full source-control surface (`git_status`, `git_diff`, `git_diff_content`, `git_file_base`, `git_stage`, `git_unstage`, `git_discard`, `git_commit`, `git_undo_commit`, `git_commit_on_remote`, `git_fetch`, `git_pull_ff_only`, `git_push`, `git_log`, `git_show_commit`, `git_commit_files`, `git_commit_file_diff`, `git_panel_snapshot`, `git_resolve_repo`, `git_remote_url`, `git_list_branches`, `git_checkout_branch`, `git_discover_repos`). All gated through the workspace authorization registry. Switching branches uses `git switch`, never `git checkout <name>`, which restores a file of that name (discarding its changes) when the branch has gone. `git_status` asks git for `--untracked-files=normal` (one `dir/` entry per untracked directory) and expands small untracked directories back into files with a bounded `git ls-files --others` (500 files and 16 directories per refresh, listing abandoned at a 256 KiB cap); a directory over budget stays collapsed as `dir/`, which stage and discard handle natively. Stage, unstage and discard hand git their paths in batches that fit one command line (16 KB of paths on Windows, whose command lines stop at 32,767 characters; 256 KB elsewhere), so Stage All on a large deleted folder still runs. Git runs with a 30 s timeout (network commands 120 s; `git_commit` 180 s, since commit hooks and signing run inside it). On Unix each git leads its own process group, and a timeout sends the group SIGTERM, then SIGKILL after 2 s (`proc::capture::OnTimeout::TerminateGroup`), so git removes its lock files (`index.lock`) and the hooks it started stop with it; Windows still kills git alone.
- `shell::shell_run_command`: one-shot subshell exec used by AI tools (bounded `proc::capture`: two short reader threads, no wait on pipes a backgrounded grandchild keeps open). Distinct from PTY sessions; not the user's interactive terminal. On Windows via PowerShell (`-NoProfile -Command`), on Unix via `$SHELL -lc`. Shared helper `build_oneshot_command`.
- `shell::shell_session_*`: persistent agent shell with state across calls. `shell::shell_bg_*` (`spawn`, `logs`, `kill`, `list`): long-running background processes (dev servers etc.) with bounded ring-buffer log capture.
- `workspace::*`: `workspace_authorize` / `workspace_current_dir` (the spawn/git/AI cwd authorization registry) plus the WSL bridge (`wsl_list_distros`, `wsl_default_distro`, `wsl_home`).
- `lsp::*` (`lsp_detect`, `lsp_host_pid`, `lsp_resolve_root`, `lsp_spawn`, `lsp_send`, `lsp_kill`): language server process host. Dumb JSON-RPC pipe: Content-Length framing + process lifecycle in Rust (`lsp/framing.rs`, pure + tested), protocol intelligence on the frontend. Spawn cwd gated through the workspace registry; binaries resolve via the env of the user's interactive login shell, captured once (`lsp/env.rs`: GUI apps get a bare PATH on macOS, and PATH set in an interactive rc file such as nvm's exists only there; the shell runs in its own session with `TERAX_RESOLVING_ENVIRONMENT=1`, `env -0` is read between markers, and a login-only capture is the fallback); root detection walks up to markers but never to or above `$HOME`. Servers run in their own process group on Unix and are group-killed (cargo check / proc-macro children die with the server); Windows children get a `proc::job::ProcessJob` (kill-on-close, shared with pty). All sessions killed on `RunEvent::Exit`.
- `clipboard_image::*` (`clipboard_image_read`, `clipboard_image_write`): clipboard images for the Kitty clipboard protocol, as PNG both ways (raw IPC bodies, 64 MiB cap), through the clipboard plugin's long-lived clipboard so a written image stays served on X11 like text. A read with no image answers an empty body; a written PNG is decoded with limits (16,384 pixels a side, 512 MiB decoded) before it reaches the clipboard. Both run on blocking workers.
- `system_fonts::system_font_faces`: an installed family's faces (file, weight, style, stretch) for terminal font features and, on macOS, for fonts the user installed, from a `fontdb` database built on first use and rebuilt when a family is missing (at most every 10 s); collection members past the first are left out, at most 64 faces.
- `primary_selection::*` (`terminal_primary_selection_write`, `terminal_primary_selection_read`): the Linux PRIMARY selection for copy-on-select and middle-click paste, through `arboard` (X11, or Wayland data-control). Two long-lived clipboards, created on first use: the writer keeps the X11 selection served after the call returns and drops a write overtaken by a newer one, the reader is separate so a read stuck on an unresponsive owner never blocks writes (one read at a time). 4 MiB cap both ways; an empty write leaves PRIMARY alone. macOS/Windows: write is a no-op, read returns `None`.
- `terminal_scrollback::*` (`terminal_scrollback_save`, `terminal_scrollback_load`, `terminal_scrollback_retain`): saved terminal scrollback, one file per pane key (`[A-Za-z0-9_-]{1,128}`) under the calling window's data root (the app data dir for `main`, `windows/<label>/` for another), so a window's `retain` never sees another's files. Raw UTF-8 bodies (key in the `x-terax-scrollback` header, 8 MiB cap, empty deletes), replaced atomically through a temp file (0600 on Unix) and never through a link; `retain` deletes every file it is not given, temp files included, and refuses an implausibly long list rather than truncate it. One gate serializes all three. See spaces/ below.
- `net::*` (`ai_http_stream`, `ai_http_cancel`, `ai_http_ack`, `lm_ping`, `image::markdown_remote_image`): AI HTTP proxy with SSRF guard; keeps provider calls and local-model pings off the webview. `markdown_remote_image` fetches one https image for the Markdown preview (public addresses only, every redirect hop validated and classified again, `image/*` only, 16 MiB) and answers `[u8 type length][type][bytes]`. Clients are cached per `(profile, host, pinned IPs, allow_private)` with a 90 s idle TTL and at most eight entries, so connections and HTTP/2 sessions are reused while DNS-rebinding protection stays per request. Classification (`net/ip.rs`) looks through IPv6 forms that carry an IPv4 destination (mapped, compatible, NAT64, 6to4, Teredo) and treats everything outside global unicast as non-public.
- `secrets::secrets_*`: OS keychain via the `keyring` crate. Service constant `terax-ai`. Linux uses a file-based fallback gated behind `#[cfg(target_os = "linux")]`.
- `open_settings_window`: separate webview window for Settings (optional `tab` arg deep-links a section). It is a child of the window it opens over (owned on Windows, transient on Linux), which keeps it above that window, and never always-on-top, which would float it over every other app.
- `quick_terminal::*` (`quick_terminal_toggle`, `quick_terminal_set_hotkey`): the quick terminal, a borderless always-on-top `quick` window (`quick.html`, `src/quick/`) holding one terminal. It is created on first use and kept, so its shell survives hiding; each show places it across the top of the work area of the monitor under the pointer at 40 % height (never restored by window-state). The hotkey (`terminalBehavior.quickTerminalHotkey`, off by default, one of a fixed list) is registered process-wide through `tauri-plugin-global-shortcut` from the main window (`terminal/quick/quickTerminalHotkey.ts`); a refused hotkey (taken, or Wayland without global shortcuts) is reported. The page hides the window when its shell exits (the next show starts a new one in the home directory) and, with `quickTerminalAutohide`, when it loses focus. It is not a child window, so the last app window's destruction destroys it (`windows.rs`). `pty_close_all` reaps only the calling window's shells.
- `windows::*` (`app_window_open`, `app_window_ready`, `app_quit`, `app_quit_ready`): app windows. `main` comes from the config; New Window (File menu on macOS, Cmd/Ctrl+Shift+N, the palette) opens `w-<n>` (lowest free number, so the window-state plugin keeps at most 32 entries) a step from the window it came from, its first terminal in that window's directory (`?cwd=`). Each window has its own spaces store (`windows/<label>/terax-spaces.json`; `main` keeps `terax-spaces.json`), scrollback root and active chat (`activeId:<label>` in the chat store; the history list is shared and every window follows its changes, and a window never reuses an untitled chat another has open). The windows open at quit are listed in `terax-windows.json` and reopen at launch; when `main` had been closed it takes over the first listed window's files, so the same windows come back. Closing a window while others stay open discards it (state files, list entry, chat key; its label is not reused until the files are gone); closing the last one quits and keeps it. The macOS menu bar is built whole (`app_menu.rs`, never by editing `Menu::default` in place): the app menu ends with our guarded Quit, and File holds New Window, Close Tab (Cmd+W: the window in front closes its active tab or pane through `terax:close-tab-requested`, which also works while a preview frame has the keyboard and the page never sees the key; Settings and the quick terminal close instead) and Close Window (Cmd+Shift+W, through the same close guard as the close button). Quitting (Cmd+Q, "Quit Terax") asks each window that answers (`app_window_ready`, set once its page listens; a page that reloads or closes while asked counts as agreeing) in turn, the focused one first, to confirm running commands and unsaved files and save its chat, scrollback and spaces (`terax:quit-requested`, answered by `app_quit_ready`); any cancel stops the quit, and only after every answer does Terax exit with all windows kept. Settings opens over the window in front and closes with it; "Open With" files and control requests without a calling pane go to the window in front. A later launch of Terax (Open in Terax, `terax <dir>`, a launcher) starts no second process on the same state files: `tauri-plugin-single-instance` (release builds; a dev build would hand off to an installed Terax) passes its arguments and directory to `second_launch.rs`, which opens its files in the window in front, a folder in a new window (`?folder=`), else a new window in the launch's directory (`?cwd=`, when usable). A folder macOS opens in Terax (Open With, dropped on the Dock icon) is the main window's launch folder until that window has read it, a new window after. A window opened during the session comes to the front when it first shows. Shells get app-wide pane ids (`TERAX_PANE_ID`), which the control server maps back to their window and pane, so `terax` commands act on the window they run in. File watches are owned per window and given back when it closes or reloads.
- `vibrancy::window_*`: native window backdrop (`window_backdrop_kind`, `window_set_backdrop`). macOS gets `NSVisualEffectMaterial::UnderWindowBackground`, Windows 11 gets Mica (gated on build >= 22000 via `RtlGetVersion`, since `apply_mica` fails on Windows 10), Linux reports `none` because blur there belongs to the compositor. The `window-vibrancy` crate is a macOS/Windows-only dependency so Linux builds never pull it.

### PTY shell integration

PTY shells are bootstrapped via injected init scripts in `src-tauri/src/modules/pty/scripts/`:

- **Unix** (`zshenv.zsh`, `zprofile.zsh`, `zlogin.zsh`, `zshrc.zsh`, `bashrc.bash`) for zsh/bash, plus `init.fish` installed to `~/.config/fish/conf.d/terax.fish` for fish. Emit OSC 7 (cwd) and OSC 133 A/B/C/D (prompt boundaries + exit code) so the host can track cwd and detect command boundaries without re-parsing the prompt. Fish 4.0+ writes its own OSC 133 prompt markers; Terax sets `fish_features=no-mark-prompt` and re-asserts its own prompt via `-C` to avoid doubling. The zsh wrappers source each user file under the user's own `ZDOTDIR` (one their `.zshenv` sets included) and move a `HISTFILE` derived from the wrapper directory to the user's, so history and `$ZDOTDIR`-relative config behave as in any terminal.
- **Windows** (`profile.ps1`) - passed via `pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <path>`. Wraps the user's existing `prompt` function (after their `$PROFILE` runs) to emit OSC 7 + OSC 133 A/B/D. Shell priority: `pwsh.exe` (PS 7+) → `powershell.exe` (PS 5.1) → `cmd.exe`. cmd.exe runs `profile.cmd` with `/k` (after AutoRun), which wraps `PROMPT` in OSC 133 D/A, OSC 7 (`$P`, unencoded, which `parseOsc7` reads as is) and OSC 133 B; with no preexec hook it marks `terax_blocks=0`, so block tabs keep its prompt. A breadcrumb `cd` is written for the pane's shell (`cdCommandLine`: `cd /d "..."` for cmd.exe). cwd is normalized to backslashes before being passed to ConPTY (`CreateProcessW` misbehaves with forward-slash cwd).

`pty/shell_init.rs` is split into `#[cfg(unix)]` / `#[cfg(windows)]` modules - keep new platform-specific code in the right cfg arm.

Shells advertise `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=terax` and `TERM_PROGRAM_VERSION=<app version>` (the XTVERSION reply is `terax <version>`; WSL gets them through `WSLENV`). The identity of whatever terminal launched Terax (Ghostty, iTerm2, kitty, WezTerm, VS Code, tmux, a parent Terax, ...) is removed first by the pure `pty/terminal_env.rs`; user configuration never is. Details in `docs/architecture/pty-shell-integration.md`.

ConPTY on Windows requires `CONPTY_LIFECYCLE_LOCK` (Mutex) around `openpty + spawn_command` in `session.rs`. Concurrent spawns leave one of the resulting PTYs with a stalled output pipe. Don't remove the lock without verifying first-tab stability under fast tab spam. The lock must never be held across anything that waits on the frontend: the waiter lets the reader overdraft the output queue (`close_pseudoconsole`) before taking the lock for `ClosePseudoConsole`, so a backlog the page has not acknowledged cannot stall other `pty_open` calls.

Each ConPTY child is also assigned to a per-session **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`proc/job.rs`, shared with the LSP host). When the Job HANDLE drops - clean shutdown, panic, or even SIGKILL'd Terax process - the kernel kills every descendant of the shell (e.g. `npm run dev` spawned from inside pwsh). Without this Windows orphans the entire process subtree because `TerminateProcess` only kills the immediate child. macOS/Linux rely on `Drop for Session → killer.kill()`; on dev-`Ctrl-C` of `cargo run` destructors don't fire and orphans are possible there too - acceptable for now since dev only.

`AiComposerProvider` is mounted unconditionally at the App.tsx root: a conditional wrapper would change the parent element type when keys load, remounting the entire tree (and re-spawning every PTY) the moment `getAllKeys()` resolves. Production happened to dodge this because keychain reads can land in the same paint frame; dev didn't. Keep the unconditional wrap.

### Frontend (`src/`)

Single-window React app. Path alias `@/*` → `src/*`. Tabs are a tagged union (`kind`: `terminal` | `editor` | `preview` | `markdown` | `ai-diff` | `git-diff` | `git-history` | `git-commit-file`) and **not** unmounted on switch - they're hidden via `invisible pointer-events-none` so PTYs and dev servers keep streaming in the background.

`App.tsx` wires modules together - keep it a coordinator. New features go inside the appropriate `modules/<area>/`.

### Module layout (`src/modules/`)

Each module is self-contained, exports a thin barrel via `index.ts`, and owns its hooks under `lib/`.

- **terminal/** - `TerminalStack` keeps live leaves mounted. `useGhosttyTerminalSession` owns one persistent model and PTY per leaf; GPU/WebGL surfaces lease shared presentation resources independently. `terminalSessionApi.ts` exposes renderer-neutral product actions. OSC 7 paths and OSC 52 payloads are validated by pure parsers; Ghostty supplies OSC 133 events and native command anchors to the lazy block controller. WebGPU can fail over to WebGL without replacing the model, PTY, selection, search, or block history. Hidden models keep parsing through bounded PTY transport while presentation is released. There is no snapshot replay or second terminal parser. Theme colors come from the central theme engine.
- **editor/** - CodeMirror 6 stack (`EditorStack` mirrors `TerminalStack`). `extensions.ts` configures language modes; supports vim mode. Buffers live in LF space and the original EOL (`lib/eol.ts`, majority-vote detection) is restored on save; indent unit/tab size are detected per file (`lib/indent.ts`) via a per-pane compartment; a file with nothing to detect (new, unindented) uses the Default indentation setting (`editorDefaultIndent`: 2 spaces, 4 spaces or tabs). The view is created a few renders after the document turns ready, after the pane's effects for it ran, so first-load work that needs the view (indent unit, a pending go-to line or focus) also runs from `onCreateEditor`. Saves are conflict-checked against the disk mtime returned by `fs_read_file`/`fs_write_file`: on a mismatch the file is read, an mtime-only change (same text) saves normally, and a real change raises a persistent warning toast with explicit Overwrite, never silent last-writer-wins (`lib/saveConflict.ts`). Every failed write (save, autosave, Overwrite) shows a per-file error toast; external format-on-save only applies the disk read-back if the doc is unchanged since the save snapshot. Document state lives in `lib/documentSession.ts` (IO injected, tested; `useDocument` is its React shell): async reads, checks and writes are dropped once the pane loaded another file or closed, and an explorer rename of an open file (`noteRetarget`) keeps the buffer, dirty state and mtime, so the next save writes the new path. CodeMirror takes its text only at mount; text adopted from disk later is pushed into the view by `syncViewText` (minimal change, cursor and undo survive), since a reload equal to the previous `value` prop never reached the view. A Source Control discard reloads the matching open editors even when dirty (`lib/gitSignals.ts`); edits typed while that read is in flight are kept. A change gutter marks lines added, modified or removed since HEAD (`lib/gitGutter.ts`: `@codemirror/merge` chunks against the committed text, updated incrementally on every edit; the base comes from `git_file_base`, one `git show HEAD:./<name>` in the file's folder, fetched when the file loads, when the pane is shown and after a commit or pull in Source Control, `lib/gitSignals.ts`; off above 4 MB). Images, video, audio and PDFs preview through asset URLs (`useWorkspaceAssetUrl`: a WSL path is mapped to its host path first; the CSP allows `asset:` and both `http(s)://asset.localhost`, since Windows uses `http`, and no remote images, since AI chat Markdown renders in the same webview). Files over 10 MB offer "Open anyway" (hard cap 50 MB, `force` arg); above 4 MB syntax highlighting and LSP stay off. Cmd-F routes to CodeMirror's own search panel (find/replace/regex) when an editor tab is active, Ctrl-G opens go-to-line, as in VS Code (`lib/editorKeymap.ts`: above the search keymap, which binds Mod-G to find-next; off macOS the pane claims Ctrl+G from Source Control, which keeps Ctrl+Shift+G there); both panels styled in `chromeTheme.ts`. Format-on-save formatters live in `lib/externalFormat.ts` (`FORMATTERS` registry: biome, prettier, ruff, rustfmt, gofmt, clang-format, shfmt, zig fmt, plus a custom `{file}` command template); `resolveFormatter` applies per-language overrides (`editorFormatterByLang`) over the global default, and a global external default only runs on languages its tool understands. Diff panes resolve the language before mounting CodeMirror: a late compartment reconfigure leaves the merge view's deleted-chunk widgets unhighlighted. Git diffs render inline (`unifiedMergeView`) or side by side (`SplitDiffView`: a `MergeView` built once and updated in place, so scroll and expanded regions survive a refetch or theme switch) per the `diffViewMode` preference (Settings > Editor, or the toggle in the diff header); both share `lib/diffTheme.ts`. AI inline completion (`lib/autocomplete/`) sends the buffer's indent unit with the request and normalizes unambiguous tab/space mismatches in responses (`normalizeIndent.ts`); triggering is `autocompleteTrigger` auto or manual, with `editor.aiComplete` / `editor.codeComplete` registry shortcuts (guarded to editor tabs so the keys fall through to terminals), and Tab accepts an open completion popup before the ghost. Multi-line ghosts render first-line-inline plus a block widget below the line (never inline `<br>`s); a closers-only line-suffix (cursor inside `fn(|)`) is hidden and re-appended after the block so the preview equals the accept result, and a line-suffix with real code caps the ghost to one line (`capToLineSuffix`). Suggestions echoing the recent prefix are dropped, multi-line suggestions and closing brackets never start on a line that ends with `;`, and closer-only lines are reindented from the previous line (`trimSuggestion`/`reindentClosers`, all tested). Markdown editing is GFM (`markdownLanguage` base) with fenced-code highlighting resolved through the shared lazy language registry, Cmd/Ctrl+Click URLs, and clickable task checkboxes (`markdownExtras.ts`, all inside the lazy markdown chunk; the eager-budget test enforces this). Dotenv files (`.env`, `.env.*`, and `*.env`) use the lazy shell grammar. Editor theme is decoupled from the app theme: the `editorTheme` pref is `"auto" | EditorThemeId` (default `"auto"`), resolved at render time by `useEditorThemeExt` via `resolveEditorThemeId`. In `auto` the editor follows the active app theme's `editorTheme[mode]` pairing (live, never stale); an explicit pick overrides. Theme ids + labels live in `settings/store.ts` (`EDITOR_THEMES`/`EDITOR_THEME_LABELS`); the matching extensions in `editor/lib/themes.ts` (`EDITOR_THEME_EXT`). Prebuilt `@uiw` themes plus locally-built ones in `editor/lib/cmThemes.ts` (Kanagawa wave/lotus/dragon, Everforest, Dracula, Solarized, Catppuccin, Rosé Pine) via `createTheme` (no extra deps). The three CM surfaces (`EditorPane`, `AiDiffPane`, `GitDiffPane`) all read the theme through `useEditorThemeExt`.
  Editor code size is stored separately as `editorFontSize` and does not affect `terminalFontSize`.
- **explorer/** - file tree with Catppuccin icons, fuzzy search, keyboard nav, inline rename, context actions. A click previews a file, a double-click keeps it open in its own tab, and F2 or Rename in the context menu renames. Backslash-aware `basename`. Icons are lazy: `iconResolver.ts` is the startup-safe shell and fetches the ~360 kB set (`iconEngine.ts`) when the first `FileIcon`/`FolderIcon` mounts; until then those components render a same-size blank slot that fades the icon in, and the set is never in either window's startup graph. The tree stays mounted when the sidebar collapses but is `visible={false}`: no native fs watchers (`watchRegistry.ts` disarms them), no `fs:changed` subscription, no drop listener and no reloads; showing it re-registers the watchers and reloads loaded directories once. `fs_watch_add` watches each directory and open file at its canonical path but reports every change (`fs:changed`) in each spelling the frontend registered it under (a WSL `/home/x` or `/mnt/c/x`, a root reached through a link such as macOS `/tmp` or Fedora Atomic `/home`), so the tree and editor tabs match their own keys. The WSL share delivers no change notifications, so its watched directories and the open files in them are re-checked every 1.5 s by a poller (`terax-fs-poll`) that starts with the first share directory and sleeps while none is watched. Refresh re-reads the root, every loaded listing and every expanded folder (`lib/refreshTargets.ts`).
- **preview/** - auto-detected dev-server preview tab (status-bar pill suggests opening when a localhost URL is detected). With `terminalLinksInPreview` on (Settings > General > Web preview, off by default), a localhost or loopback link clicked in a terminal opens in a preview tab, reusing the space's tab already showing that page, instead of the browser (`terminalLinkPreviewTarget`, registered through `setTerminalPreviewOpener`).
- **tabs/** - `useTabs` is the source of truth for tab list + active id. `useWorkspaceCwd` derives explorer root + inherited cwd for new tabs from the active space only: its active terminal, else the terminal last active there, else its terminals, else its root (`spaceExplorerRoot`, `spaceNewTabCwd`). A tab holds up to eight panes (`MAX_PANES_PER_TAB`). In a split, panes other than the focused one fade toward the terminal background (`terminalBehavior.unfocusedSplitOpacity`, Ghostty's unfocused-split-opacity, 0.7 by default, 1 for off; an overlay in `PaneTreeView`, no renderer work). Live terminals move without restarting: "Move to split" (tab menu) grafts a single-pane terminal tab into another tab's split beside its active pane, "Move pane to new tab" (tab menu, palette) pulls a pane out of a split. Both move the same leaf node within one tab-list update, so the leaf never leaves the live pane trees and its session, scrollback and running program stay (`planMoveTabIntoSplit`, `planMovePaneToNewTab`); agent records follow the pane to its new tab (`moveAgentLeafToTab`). `basename` splits on both `/` and `\`.
- **header/** - top bar + inline search (`SearchInline` adapts to terminal vs editor via `SearchTarget`). `WindowControls` rendered when `USE_CUSTOM_WINDOW_CONTROLS` is true (Linux + Windows; macOS uses native traffic lights).
- **statusbar/** - bottom bar, `CwdBreadcrumb` (handles Unix paths, Windows drive letters, and home `~` segments via `pathUtils.segmentsFromCwd`), AI tools indicator. A breadcrumb types `cd` only while the pane's shell is at its prompt (`leafShellAtPrompt`: no command running per OSC 133 and no job owning the terminal, `pty_has_foreground_job`); otherwise a toast offers the folder in a new tab.
- **shortcuts/** - keymap registry (`shortcuts.ts`) + `useGlobalShortcuts`. Handlers live in `App.tsx` and are passed in by id (`tab.new`, `ai.toggle`, …). `metaKey || ctrlKey` for cross-platform Cmd/Ctrl. Defaults are per platform (`defaultShortcuts`, its test locks the table and checks that no two defaults share a chord on any platform). macOS uses Cmd. On Windows and Linux every app shortcut macOS puts on Cmd+key is Ctrl+Shift+key first, as in Ghostty and Windows Terminal, with plain Ctrl+key kept as a second binding; the Ctrl+Shift shortcuts that chord displaced (Find in files, New Blocks terminal, explorer focus and search, split down, AI chat window, next/previous space) are Ctrl+Alt+Shift, and Toggle input bar is Ctrl+Alt+Shift+U on Linux, where input methods take Ctrl+Shift+U. A focused terminal keeps plain Ctrl+<letter> and Ctrl+[ ] \ / for its programs (`shouldDeferShortcutToTerminal`), so there only the Ctrl+Shift binding runs. Ctrl+Alt bindings never fire while AltGr is held (Windows reports it as Ctrl+Alt). A user's own binding wins over a default on the same chord, and keys an input method is composing with never trigger a shortcut (`matchShortcut`). Shortcut labels in the UI read the registry (`useShortcutText`, `shortcutLabel`), so they follow the platform and user bindings. Global shortcuts run in the capture phase, so a text box that handles a ⌘/Ctrl chord of its own marks it with `data-claims-mod-key="<key>"` and keeps exactly that chord while focus is inside it (`focusClaimsChord`): the commit message box generates a message on ⌘G / Ctrl+G, which elsewhere toggles Source Control, and off macOS the code editor keeps Ctrl+G for go-to-line.
- **settings/** - settings store (`store.ts` via `tauri-plugin-store`), preferences hook, settings window opener. The Settings window is closed (not hidden, so its WebContent process is released) when it hands a theme edit to the main window; `open_settings_window` rebuilds it on demand.
- **sidebar/** - activity bar + collapsible side panels (explorer, source control, git history).
- **source-control/** - git status / stage / commit panel and diff workflow. `useSourceControl` takes a `live` flag (`statusConsumers.ts`): `git status` runs on window focus and context changes only while the Source Control panel, a git tab or the explorer's git decorations are on screen. Otherwise nothing runs, a snapshot for another repository is dropped (never a wrong badge), and the next consumer to appear refreshes it. The rail badge alone is not a consumer; it refreshes lazily. While live with a repository it also follows changes made while the window keeps focus: `git_watch_add` (`fs::watch`) watches the repository's git directory (top level and its state files, polled on the WSL share) and relates activity in the work tree's watched folders and Terax's own file writes to it, emitting `git:changed`; a command that finishes in a terminal inside the repository (or inside the followed context, which may be spelled through a link) counts too. Signals settle into one refresh (`refreshSignals.ts`: 300 ms quiet, 1.5 s at most, one more when a signal lands during a refresh), and the watch is released when the view goes. Status reads never write the git directory (`GIT_OPTIONAL_LOCKS=0`), so a refresh cannot trigger the next. In-place edits by a long-running program in a folder nobody watches still wait for focus. When the followed folder is not a repository, the panel lists the repositories inside it (`git_discover_repos`: children and grandchildren, not inside a repository, hidden or dependency folders, links not followed, at most 256 folder reads and 24 results) and opens one the way the explorer's Open in Source Control does.
- **git-history/** - commit graph rail, refs, per-commit file diffs. History pages are slices of `git log <newest loaded commit> --skip=<loaded count>` (`lib/historyPaging.ts`), so commits reached only through a merge are never dropped and a moved HEAD never shifts a page. Each commit carries its refs from `%D` under `--decorate=full`, classified by namespace in Rust (`git::parser::parse_decorations`: HEAD, branch, tag, remote; `origin/HEAD`, the stash and notes are left out), drawn as chips before the subject (two and a count in a row, all in the detail) and matched by the search. The detail of the commit HEAD's branch points at offers Undo Commit (`git_undo_commit`, `git reset --soft HEAD~1` as a compare-and-swap of HEAD against the chosen commit, so a commit made meanwhile fails it; ORIG_HEAD is set and the changes stay staged), with a warning when `git_commit_on_remote` finds the commit on a remote branch.
- **lsp/** - opt-in language server support, zero cost until enabled (no process, no PATH check, nothing in the eager bundle beyond a 14.5 kB shell). Statusbar pill offers Enable (binary found) or Install (with copyable command) per language; activation persists as `lspActivation` in the settings store (`enabled`/`dismissed`/unset). `sessionManager.ts` keys sessions by (server, workspace root), refcounts open docs, idle-kills after 3 min, and crash-backoffs (cooldown before respawn; 3 in 5 min → give up + toast with the server's stderr tail). Resource invariants: **no root marker → no session** (the status pill says so for the open file instead of disappearing) (a dirname fallback once spawned a server per directory and burned GBs), hard cap of 4 sessions per server, lean per-preset `initializationOptions` (rust-analyzer: `cachePriming` off + bounded `lru`; tsls: `maxTsServerMemory`). Client is `codemirror-languageserver` behind a lazy import, subclassed (`lib/client.ts`) to add didClose/didSave/shutdown, `textDocument/references` (Shift-F12; multi-result definitions and references share the `locationsPanel.ts` picker) and the publishDiagnostics capability the lib forgets (tsls sends no diagnostics without it); `lib/transport.ts` bridges to the Rust pipe and answers server-to-client requests the lib ignores. Location URIs are compared decoded with the drive letter's case ignored (`sameFileUri`; pyright sends `file:///d%3A/...`), and file tabs dedupe by `pathKey` (`@/lib/pathKey`), so a definition in an open file moves its cursor instead of opening a duplicate tab. `vscode-languageserver-protocol` is aliased to a 4-enum shim in vite.config.ts (~117 kB saved). Presets: typescript, rust-analyzer, pyright, ruff, gopls and more; custom stdio servers via Settings. Several presets can claim one language (pyright and ruff both take `py`): `serverForLanguage` prefers the enabled candidate, so enabling ruff while pyright is unset or dismissed routes Python to ruff. WSL workspaces excluded for now.
- **markdown/** - markdown preview renderer (backs the `markdown` tab kind). Markdown tabs are in the fs watch set (`editor/lib/fileWatchTargets.ts`); the preview re-reads its file when the watcher or a Terax write (`fs:file-written`) reports a change, and a failed re-read keeps the last render (`previewStatus.ts`). Relative images resolve against the document's folder (`localImages.ts`, a rehype step after the sanitizer, so an `asset:` URL written in the file stays stripped, and before harden, which would rewrite `./a.png` onto the app origin) and load through `useWorkspaceAssetUrl`; https images are fetched by `markdown_remote_image` and shown as object URLs shared by `RemoteImageCache` (on-screen images kept, 32 unused ones cached, the rest revoked). The CSP loads no remote images because AI chat Markdown renders in the same webview, so chat images stay blocked. The rehype chain is `previewPipeline.ts`: a leading YAML frontmatter block renders as a key/value table (`frontmatter.ts`), GitHub alerts (`> [!NOTE]`) as callouts (`githubAlerts.ts`, `markdownPreview.css`), and headings get GitHub slug ids under the `user-content-` prefix the preview's sanitizer restores (Streamdown drops it; unprefixed ids could clobber the app's own), so `#section` links scroll the pane (`PreviewLink`, `headingAnchors.ts`), while a relative file link never navigates the webview.
- **workspace/** - workspace environment switching (Local + WSL distros). A space keeps one environment; the status-bar picker (Windows) moves to the first space with the picked environment, else opens a space at its home (`planEnvSwitch`), and never closes a shell or tab of any space.
- **theme/** - custom theme engine (no `next-themes`). `ThemeProvider` + `applyTheme` write CSS variables; built-in presets in `themes/` (terax-default - colours live in `globals.css` since ThemeProvider clears rather than applies for that id - xcode, claude, kanagawa, kanagawa-dragon, tokyo-night, catppuccin, rose-pine, everforest, nord, gruvbox, dracula, solarized, github, one-half, ayu, ayu-mirage, night-owl, tomorrow, flexoki, tide, sage, caffeine), each optionally declaring an `editorTheme` pairing consumed by `resolveEditorThemeId` (see editor/). The terminal palettes of github through flexoki are Ghostty's own copies, verbatim (`themes/NOTICE.txt`, bundled under `licenses/themes/`; `bundled.test.ts` checks them against the fixtures). User themes via `customThemes.ts` + `validateTheme.ts`; Settings → Themes also imports Ghostty, iTerm2 (`.itermcolors`), Alacritty (TOML/YAML) and Windows Terminal schemes through the dependency-free, lazily loaded parsers in `schemes/`, which keep the terminal colours exact and derive the app chrome from them (`schemes/scheme.ts`, contrast-checked; an inverting selection becomes a translucent overlay so selected text stays readable), optional background image via `bgImageStore.ts` + `SurfaceLayer` (a fixed layer over the whole page that drops under a modal's overlay while one is open, so the overlay dims and blurs it too).
- **updater/** - auto-updater UI built on `tauri-plugin-updater`, off (`UPDATES_ENABLED`) until this fork publishes its own releases: no check runs, no window offers an update, About says updates are off, and the plugin has no endpoint and the webview no `updater:default` permission.
- **agents/** - agent launching, notifications, and management for both the built-in Terax agent and terminal coding agents (Claude Code, Codex, Gemini CLI, Pi, OpenCode, Grok). The header launcher (`components/AgentLauncherPanel.tsx` + `lib/launcher.ts`) persists per-agent start commands in preferences and atomically builds balanced one-to-four-pane tabs. Shared store (`store/agentStore.ts`: terminal `sessions` + `localAgent` + `notifications`) and a shared router (`lib/route.ts`: suppress when focused-and-visible, OS-notify when unfocused, in-app Sonner toast when focused-but-hidden) feed the header `NotificationBell` (management surface, Terax agent listed first, per-agent hook enable rows). Toasts use Sonner (`components/ui/sonner.tsx`) themed via the central engine; `lib/agentIcon.tsx` renders the per-agent brand mark. Terminal detection is Rust-side (`pty/agent_detect.rs`) on the PTY reader's byte filter, armed on `OSC 133;C;<cmd>` or self-armed by the marker, emitting `terax:agent-signal` transitions (`started`/`working`/`attention`/`finished`/`exited`) driven only by OSC sequences (never raw output, so a repainting TUI never flaps) - zero cost when no agent runs. Hook-backed terminal agents converge on the same `OSC 777` marker the detector reads, installed via `agent_enable_hooks(agent)` / `agent_hooks_status(agent)` in `modules/agent.rs` (data-driven `AgentSpec` for JSON-hook agents plus a Terax-owned Pi extension; atomic writes, foreign configuration preserved, idempotent; gated on `TERAX_TERMINAL`). OpenCode and Grok use OSC 133 process-lifecycle detection but do not install attention hooks. Delivery differs because only Claude's hook protocol can return terminal bytes in the hook *response*: **Claude** (`~/.claude/settings.json`, `UserPromptSubmit`/`Notification`/`Stop`) returns the marker via the `terminalSequence` field (legacy 3-field `notify;Terax;<event>`). **Codex** (`~/.codex/hooks.json`, `UserPromptSubmit`/`PermissionRequest`/`Stop`) and **Gemini** (`~/.gemini/settings.json`, `BeforeAgent`/`Notification`/`AfterAgent`, `matcher:"*"`) can't, so the hook *command* emits the 4-field `notify;Terax;<agent>;<event>` marker itself (`printf > /dev/tty` on Unix, or `terax __terax_notify` writing to `CONOUT$` after `AttachConsole` on Windows) and prints `{}` as a JSON stdout no-op (Codex's `Stop` and Gemini both reject empty/non-JSON stdout). **Pi** (`~/.pi/agent/extensions/terax-notifications.ts`) uses `agent_start`/`agent_settled` extension events and writes its named marker directly to stdout. The agent-named marker lets a self-arm name the right agent when no preexec fired (bash/tmux/Windows). The Terax agent path is `ai/components/LocalAgentNotificationsBridge.tsx`, mapping `chatStore.agentMeta` (`awaiting-approval`→attention, busy→idle→finished, `error`) into the same router.
- **command-palette/** - modal command palette (`CommandPalette.tsx`, `commands.ts`) for actions and navigation.
- **spaces/** - workspace spaces/projects (name, root, env, color, per-space tab persistence) via `useSpaces` and `SpaceSwitcher`. Each app window has its own spaces (`lib/appWindow.ts`, `windows::*`). A folder Terax is asked to open (a folder argument or Open in Terax for `main`, `?folder=` for a later launch's window; never the process's own directory or a launched file's folder, `getExplicitLaunchDir`) wins over the restored spaces: `bootSpaces` activates the local space rooted there, else adds one named after it, on a terminal whose active pane is there, else a new one (`applyExplicitLaunchDir`); with no saved spaces it roots the first, local, space there.
  Terminal scrollback survives restarts (`terminal/lib/terminalScrollbackRestore.ts`, format in `terminalScrollback.ts`, files in `modules/terminal_scrollback.rs`). Leaf ids change every launch, so each pane gets a random key stored with its leaf in the space state. Its newest 5,000 lines (at most 4 MiB, text and SGR styles) go to `<app data>/terminal-scrollback/<key>.vt` (atomic replace, owner-only) whenever the space state flushes and when the window closes (bounded to 1.5 s, in parallel with chat history); unchanged panes and panes in the alternate screen are skipped, and each save sweeps the files of closed panes, tabs and deleted spaces. Private tabs are never saved. A restored pane gets the history, with everything but text and SGR stripped (a file can never move the cursor or make the terminal answer the new shell), and a dim "Restored <date>" line before any shell output; output that arrives while the file loads is held (2 s, 1 MiB) and follows it. Exports read 256-row chunks, so a pane's WebAssembly memory does not grow by the size of its history. Settings, General, Terminal, "Restore scrollback after restart" (`terminalBehavior.restoreScrollback`, on by default) turns it off and deletes every file.
- **ai/** - see below.

### AI subsystem (`src/modules/ai/`)

BYOK. Cloud providers via `@ai-sdk/*`: **OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter**, plus **OpenAI-compatible** for any custom base URL. Local / offline providers (key-optional, model id supplied at runtime): **LM Studio, MLX, Ollama**. Provider list in `config.ts` (`PROVIDERS`); model registry includes `DEFAULT_MODEL_ID` + `DEFAULT_AUTOCOMPLETE_MODEL`.

- **Key storage**: OS keychain via `keyring` (Rust). Frontend reads/writes through `secrets_*` commands. Service `KEYRING_SERVICE = "terax-ai"`. Never persist keys to disk, settings store, or `localStorage`.
- **Agent** (`lib/agent.ts`): `runAgentStream` calls `streamText` with the tools, `toolApproval: TOOL_APPROVAL` and `stopWhen: isStepCount(MAX_AGENT_STEPS)`, and the system prompt from `config.ts`. Provider branching happens here (`buildLanguageModel`). `lib/transport.ts` (`createContextAwareTransport`) is the chat transport and returns `toUIMessageStream(...)`; the rest of the system depends on AI SDK v7 chat semantics.
- **Sub-agents** (`agents/registry.ts`, `agents/runSubagent.ts`): named sub-agents with their own system prompts and tool subsets, invoked by the main agent via `run_subagent` tool.
- **Sessions** (`lib/sessions.ts` + `store/chatStore.ts`): conversations are organized into named sessions. `terax-ai-sessions.json` retains only metadata and `activeId`; message arrays live in atomically replaced `conversations/session-<id>.json` files owned by Rust. Messages cross IPC as raw JSON bytes (validated by a streaming pass, never rebuilt as a document tree); every save flushes the new file (plain `fsync`) before the rename and keeps the replaced version as `session-<id>.json.bak`; mid-stream saves are scheduled at most every 2 s and at least every 4 s, while turn end, session switch and window close save durably (full flush, `F_FULLFSYNC` on Apple, plus a directory sync). A queued write for a session is replaced by a newer one, and a damaged file is set aside as `session-<id>.json.corrupt` and the load falls back to the `.bak` before the conversation reads as empty, so one bad conversation never breaks the rest. Legacy migration is per session: it removes a legacy key only after its message file is safe, never overwrites a newer file on retry, skips and reports a failing key, and deletes `terax-ai-sessions.before-message-files.json` once every conversation that copy holds, not only the ids the caller lists, reads back as a valid file (a leftover copy older than seven days with nothing to migrate is pruned at startup, and deleting a session scrubs it from the copy). Window close flushes with a timeout and never traps: a failed flush shows a "Close anyway" error once. Per-session queues and a native I/O gate serialize storage operations across page reloads; failed latest writes remain retryable, and window close flushes pending storage. `chatStore.ts` keeps a module-scoped `Map<sessionId, Chat<UIMessage>>`; `getOrCreateChat(sessionId)` lazily constructs a `Chat`, seeded with messages from a hydration map populated by `hydrateSessions()` (called once from `App.tsx`). At most eight chats stay constructed (`touchChat`); eviction persists and stops the oldest, never the touched one, the active one or one still answering. `AgentRunBridge` mirrors active-session messages to disk on every change and auto-derives titles from the first user message. Switching the API key wipes the chat map; sessions persist.
- **Composer** (`lib/composer.tsx`): React context providing shared input state (text, attachments, voice) for both the docked `AiInputBar` and any other surface. Attachments include image, text-file, and `selection` kinds (an image pasted into the composer, such as a screenshot, attaches as an image while text on the same clipboard still pastes, `lib/pastedImages.ts`) - selections come from `useChatStore.attachSelection(text, source)` (drained into chips, not pasted into the textarea) and are wrapped as `<selection source="terminal|editor">…</selection>` blocks at submit. Composer derives `isBusy` from `agentMeta.status` so it can mount safely before sessions hydrate.
- **AI HTTP transport**: binary request bodies and response packets avoid JSON byte arrays. Native requests are owned by their calling window, explicitly cancelled on abort, page reload, or window destruction, and bounded to 16 concurrent requests. A 128 KiB byte window (at most 256 packets) carries at most 64 KiB per packet and coalesces ready network chunks; the webview acknowledges validated cumulative byte boundaries once half a window has arrived, so small SSE chunks cost no per-chunk IPC, and a consumer that grants no credit for two minutes is abandoned and its request cancelled. The frontend consumer queue is capped at 192 KiB, request bodies at 64 MiB, and request metadata at 64 KiB. Consumer cancellation during startup is repeated after native registration completes. SSRF validation and DNS pinning remain in Rust.
- **Voice input**: streamed transcription pipeline. Toggled from the composer.
- **Live context bridge**: `App.tsx` calls `setLive({ getCwd, getTerminalContext, … })` so tools can read the *currently active* terminal's cwd + last 300 lines of buffer. Lazy by design - don't pre-snapshot.
- **Tools** (`tools/tools.ts`): `TOOL_APPROVAL` classifies every tool (exhaustive, so a new tool does not compile until classified) and is passed as `toolApproval` to every generation. `read_file`, `list_directory`, `grep`, `glob` and the other read-only tools auto-execute. `write_file`, `edit`, `multi_edit`, `create_directory`, `bash_run`, `bash_background`, `spawn_coding_agent`, `send_to_agent` are `user-approval`: the AI SDK pauses for an in-UI confirmation card. Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`. `lib/security.ts` is a deny-list refusing obvious secret paths (`.env*`, `.ssh/`, credentials, keychain dirs) - apply on **both** read and write paths and don't bypass it.
- **Edit diffs**: AI-proposed edits open in a side-by-side diff tab (`ai-diff` tab kind); user accepts/rejects per hunk before the write tool actually runs.
- **Superseded approvals**: only the newest message's approvals can be answered (`lib/toolApprovals.ts`). Every user message goes through `sendUserMessage` (`store/chatRuntime.ts`), which first settles unanswered approvals as denied, so no tool call is ever left without a result (`MissingToolResultsError`).
- **Prompt snippets** (`#handle`): reusable prompt fragments surfaced in the composer. Do not describe these as skills; a reusable tool-bundled skills system is not implemented yet.

### UI conventions

- **shadcn/ui** is configured (`components.json`, style `radix-luma`, base `mist`, icon lib **hugeicons**). Primitives in `src/components/ui/` - don't hand-edit; re-run `bun run shadcn add` to upgrade.
- **AI Elements** (Vercel) live in `src/components/ai-elements/` from the `@ai-elements` registry in `components.json`. Same rule: regenerate, don't hand-patch - composition wrappers belong in `modules/ai/components/`.
- **Tailwind v4** - no `tailwind.config.*`, config is in `src/styles/globals.css` via `@theme`. Use `cn()` from `@/lib/utils`.
- Animation: `motion` (Framer Motion successor). Resizable layout: `react-resizable-panels`.
- **Animation cost**: nothing animates forever at display rate. Tailwind `animate-spin`/`animate-pulse` are redefined in `globals.css` with `steps()` (12 and ~4 fps), the text shimmer uses 40 steps per sweep, recording indicators use `.terax-blink`, a pending tool approval uses the finite `.terax-attention-pulse`, and persisted history (`bash_background`) never animates. `modules/theme/windowActivity.ts` sets `html[data-window-inactive]` while the window is unfocused, hidden or occluded (DOM focus, document visibility and the terminal's shared native presentation feed, no extra native listener); that attribute pauses every CSS animation and an animated background image freezes on a still frame (`surfaceFrame.ts`). `prefers-reduced-motion` still removes the rest.
- **Compositing budget**: every composited layer costs a backing store, and WebKit allocates a new one per window-resize step for each layer that follows the window. At rest the shell has three layers with contents (page tile, terminal canvas, the terminal's hidden textarea); everything else is clip layers without backing. Do not add `will-change`, 3D transforms (`translateZ`, `transform-gpu`), `backdrop-filter`/`backdrop-blur` or blur filters to anything mounted by default; popovers, HUDs and chips use an opaque `bg-popover`/`bg-card` instead of a translucent blurred one. Only the allowlist in `src/styles/compositingBudget.test.ts` (modal scrims, the background-image overlay, ...) may, each with a reason. A static background image gets no layer (`surfaceOwnsLayer`). While a window drag is live, `html[data-live-resize]` (`modules/theme/livePageResize`, macOS only) gives the document an invisible size rounded up to 512 px so WebKit keeps one page tile size across the drag instead of one per step (`docs/architecture/app-lab.md`, "Compositing layers").
- **React Compiler** runs natively: `@vitejs/plugin-react`'s `compiler` option uses `oxc-transform-react`, a Rust port, so the build has no Babel pass (`vite build` about 2 s instead of 15). It applies the same rules-of-React bailouts as `babel-plugin-react-compiler` and additionally compiles components with value blocks inside try/catch, which the Babel plugin skips. `react-compiler-healthcheck` (CI, advisory) still runs the Babel plugin's checks.
- **Startup graph**: neither window may preload the AI SDK, zod, Streamdown, CodeMirror or the icon set. `vite.config.ts` splits chunks with two prioritised `codeSplitting` groups (eager `react`/`radix`/`ghostty-vt` outrank lazy features, because a lazy chunk's recursive dependency capture once swallowed React's CJS entry and made the eager `react` chunk import every AI provider). `src/app/dist-budget.test.ts` builds into a temp dir with sourcemaps and fails if any forbidden package or chunk is reachable from `index.html`/`settings.html`; `bun run check:dist` runs the same check on `dist/`. `eager-budget.test.ts` keeps the source-graph check.
- **Native context menu**: every window's entry installs `lib/nativeContextMenu.ts`, which prevents the webview's own menu except in text fields, the terminal (it hands the menu its selection) and on selected text that is no link or image: its page menu offers Reload, which reloads the window and ends every shell in it, and its link and image menus open them inside the webview. Our own menus (Radix) prevent it themselves. Ask AI appears only after a plain primary click, never with the text menu.
- **Long AI chats**: messages older than the newest two get `content-visibility: auto` with an estimated `contain-intrinsic-size` (`messageHeightEstimate.ts`), so layout and paint cost tracks what is near the viewport.
- **Window vibrancy**: the `windowVibrancy` pref drives `WindowVibrancyBridge` (main window only - `window_set_backdrop` targets its caller). `html[data-vibrancy="on"]` (off by default; an explicitly stored choice always wins) makes `<html>`/`<body>` transparent and redefines `--frame` with alpha, so only the chrome frosts; panes keep `--background` so terminal text stays on a solid surface and the terminal canvas still matches its container. The opaque colour the pre-paint script parks on `<html>` would cover the backdrop, so `applyVibrancy` clears it while the effect is on; there is deliberately no localStorage fast path, since pre-declaring the effect would show a see-through window on any launch where the native call has not landed yet. Repeat applications are deduped, and only Mica is rebuilt on a light/dark flip (NSVisualEffectView adapts on its own).
- **Floating panes**: header and status bar are window chrome painted on `--frame` (derived from `--card`, so no theme declares it); the sidebar and the tab surface are `.terax-pane` cards on `--background` - same tone as the terminal canvas. Panes meet the chrome flush and are inset only horizontally, because the header centers its content and any vertical gutter would stack onto that padding and read as asymmetric. `.terax-pane` carries no drop shadow: `react-resizable-panels` clips panel content at the panel box, so a shadow would only render on the gutter sides.
- Path imports: always `@/…`, never relative across modules.
- Cross-platform paths: anywhere a path may originate from OSC 7, the explorer, or the OS, normalize separators with `.split(/[\\/]/)` rather than `.split("/")`.
- Canonical path form on the frontend is **forward-slash**. `homeDir()` returns backslashes on Windows; convert at the boundary (App.tsx setHome). OSC 7 already arrives as forward-slash. Equal canonical strings keep `useFileTree` from wiping its tree and flashing the explorer when `tab.cwd` first arrives.

### Window styling

- macOS: `titleBarStyle: Overlay` + `hiddenTitle: true` in `tauri.conf.json` (native traffic lights via overlay). Every app window puts the traffic lights at (14, 22), centred on its 40 px header (`trafficLightPosition` for `main`, `windows::TRAFFIC_LIGHTS` for the others), Settings 2 px lower on its 44 px header; in fullscreen, which hides them, the header drops the room it keeps for them. `lib/windowFrame.ts` follows each window's maximized and fullscreen state (one read in flight at a time, on resize) for `useWindowFrame` and as `data-window-maximized` / `data-window-fullscreen` on `<html>`. The main window is created opaque, because a non-opaque `NSWindow` makes WindowServer blend every terminal frame. `window_set_backdrop` makes the window and its `WKWebView` (`drawsBackground`) see-through only while vibrancy is on, and paints the opaque window with the theme's frame colour otherwise. `macOSPrivateApi: true` stays for that `WKWebView` key and the private `NSVisualEffectView` hosting, so the macOS build uses a private API and is not App Store eligible.
- Linux: `decorations: false` + `transparent: true` from `tauri.linux.conf.json`; re-asserted post-realize for GNOME/Mutter CSD. Windows and Linux stay transparent from creation because the borderless chrome paints its own rounded corners; a maximized or fullscreen window squares them and drops the frame's edge (`data-window-maximized`, `data-window-fullscreen`), and Settings rounds at 8 px to match the frame Windows 11 draws around its shadowed window. WebKitGTK commits DMABUF buffers without an explicit-sync acquire point, which an explicit-sync compositor (KWin 6.6+) answers with a protocol error that ends Terax before its window maps on NVIDIA, so `main.rs` sets `__NV_DISABLE_EXPLICIT_SYNC=1` before GTK starts, only on Wayland with `/sys/module/nvidia` present and never over a value the user set; PTY shells and one-shot commands get it removed again (`workspace::child_env_overrides`). WebKitGTK answers `prefers-color-scheme` from GTK 3's settings, which GNOME 42+ and KDE leave alone, so `color_scheme.rs` reads `org.freedesktop.appearance color-scheme` from the settings portal at start and on every change and mirrors it into `gtk-application-prefer-dark-theme` (no preference restores GTK's own value).
- Windows: same as Linux via `tauri.windows.conf.json`. React renders custom `WindowControls`.

### Tauri capabilities

`src-tauri/capabilities/default.json` is the allowlist for plugin APIs available to the webview. New plugins (dialog, autostart, updater, window-state, store, opener, os, log are wired in `lib.rs`) typically need:
1. `Cargo.toml` dependency
2. `.plugin(...)` call in `lib.rs` `run()`
3. capability entry in `default.json`

### Cross-platform conventions

- HOME / cache dirs: use the `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`), never raw `$HOME` / `%USERPROFILE%`.
- Shell init scripts: gate Unix-only logic behind `#[cfg(unix)]`; Windows arm in `pty::shell_init::windows`.
- Terminal input: send `\r` (CR) for Enter, not `\n` (LF) - PowerShell on Windows requires CR.

### Bundle config

- `bundle.targets: "all"` plus per-platform sections in `tauri.conf.json`:
  - **macOS**: `minimumSystemVersion: 13.3`, the first release whose WebKit (Safari 16.4) parses the bundle: class static blocks (Radix, in the startup chunk) and regular expression lookbehind (Streamdown) are syntax errors in macOS 13.0 to 13.2, and a startup chunk that fails leaves the window blank. Tailwind v4 also targets Safari 16.4. `dist-budget.test.ts` scans every built chunk for syntax newer than the declared minimum's Safari.
  - **Linux**: deb depends `libwebkit2gtk-4.1-0`, `libgtk-3-0`; rpm `webkit2gtk4.1`, `gtk3`; AppImage bundles its media framework.
  - **Windows**: NSIS installer in `currentUser` mode (no admin required), WebView2 via `downloadBootstrapper`. Installing a missing WebView2 runtime requires internet access; there is no bundled offline runtime. Packaged and offline-install validation remains in the release-readiness gates.
- Auto-updater configured with upstream's public minisign key and no endpoint while updates are off (see updater/); turning them on takes our own release feed and key.
- `bundle.resources` includes the upstream Ghostty, Restty, ghostty-web, and xterm.js license notices under `licenses/terminal/`, and the Terax Symbols (Symbols Nerd Font and its icon sets) notice under `licenses/fonts/`. Repository documentation and test-only reference WASM cores are not packaged; the frontend includes only the adapted SIMD and scalar cores.

### Known gotchas

- **Syntax highlighting identity**: parsers and editor themes must use the same `@lezer/highlight` instance. The `overrides` entry in `package.json` resolves every consumer to one copy; raise it together with the direct dependency to upgrade them all at once. Duplicate copies silently hide token styles even when parsing succeeds. Language highlighting tests exercise every editor theme and chat code blocks; the built-output check also requires one highlighter module.
- **React 19 strict mode** double-mounts `useEffect` in dev → terminals spawn twice on first render. The first PTY is cleaned up almost immediately. The `CONPTY_LIFECYCLE_LOCK` mutex serializes this; don't be alarmed by `pty opened id=1` followed by `pty closed id=1` in dev logs.
- **Windows PowerShell process lifecycle**: `killer.kill()` from `portable-pty` only kills the immediate child. Descendants (e.g. `npm run dev` started inside pwsh) survive unless something else takes them down. The Job Object in `proc/job.rs` handles this for the Terax-process-death case; an explicit `pty_close` from JS also kills only the immediate child + relies on the Job to take the rest. Don't disable the Job without a replacement.
- **Panics**: release builds unwind (`panic = "unwind"`), so a panic ends only its thread or async task. `modules/panics.rs` logs every panic (there is no crash report), long-lived loops (fs watcher) isolate each unit of work, a PTY reader panic fails that terminal at once, and the PTY hub aborts the process because its state cannot be trusted afterwards. A panic on the main thread (non-async commands, window and menu callbacks) still ends the app. A panic while holding a `std` lock poisons it; recover with `unwrap_or_else(PoisonError::into_inner)` on shared hot-path locks.
- **Tab `cwd` storage**: comes from OSC 7 with forward slashes (after `parseOsc7` strips `/C:` → `C:`). Anything that consumes `tab.cwd` and passes it to a Rust fs command on Windows must normalize separators or accept both forms - `apply_common` in `pty::shell_init` handles this for PTY spawn; other call sites must do their own.

## Further reading

Long-form contributor guides live under `docs/`. These guides elaborate on `TERAX.md`; if anything conflicts, `TERAX.md` wins.

- `docs/README.md` - index of contributor guides
- `docs/architecture/two-process-model.md` - IPC boundary and command reference
- `docs/architecture/pty-shell-integration.md` - PTY, shell init scripts, OSC, ConPTY, Job Object
- `docs/architecture/pty-transport-v2.md` - multiplexed PTY output stream: hub, wire format, presentation classes, credit; `scripts/pty-smoke/` drives it in a real debug app (`bun scripts/pty-smoke/run.ts`)
- `docs/architecture/security-model.md` - consolidated security model and boundaries
- `docs/architecture/ai-subsystem.md` - AI stack, sessions, tools, adding a provider
- `docs/architecture/terminal-renderer-pool.md` - model ownership and presentation pool invariants
- `docs/contributing/testing.md` - testing contract and core-subsystem invariants
