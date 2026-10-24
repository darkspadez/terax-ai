<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="Oarlock" />
  <h1>Oarlock</h1>

  <p><strong>Lightweight terminal-first AI-native dev workspace.</strong></p>

  <p>
    <a href="https://github.com/qopsc/oarlock/releases"><img src="https://img.shields.io/github/v/release/qopsc/oarlock?label=version&color=blue" alt="version" /></a>
    <a href="https://github.com/qopsc/oarlock/actions/workflows/ci.yml"><img src="https://github.com/qopsc/oarlock/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platform" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license" /></a>
  </p>
</div>

---

Oarlock is a lightweight open-source terminal-first AI-native development environment (ADE) built on Tauri 2 + Rust and React 19. A native PTY backend with a libghostty-vt terminal drawn by WebGPU (WebGL as the fallback), an agentic AI side-panel that runs against your own keys or fully local models, plus a code editor, file explorer, source control with a git graph, and a web preview pane built in. No telemetry. No account.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/web-preview.png" alt="Web preview" /><br/><sub>Web preview of local dev servers</sub></td>
    <td align="center"><img src="docs/ai-workflow.png" alt="AI window" /><br/><sub>Agentic AI workflow with edit diffs in the code editor</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/themes.png" alt="Themes and background image" style="margin-top: 12px;"/><br/><sub>Custom themes, presets, and background images</sub></td>
    <td align="center"><img src="docs/source-control.png" alt="Source control and git graph" style="margin-top: 12px;"/><br/><sub>Source control panel with git graph in history</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/terminal.png" alt="Terminal" style="border-radius: 4px; margin-top: 12px;" /><br/><sub>Block-based GPU terminal with editor-like input panel</sub></td>
  </tr>
</table>

## Features

### Terminal

- libghostty-vt terminal core with a WebGPU renderer (WebGL fallback), multi-tab with background streaming
- GPU-accelerated block-based terminal with editor-like command input
- Native PTY backend via `portable-pty` (zsh, bash, pwsh, fish, cmd)
- Split panels (horizontal and vertical)
- Inline search, link detection, true-color, Kitty graphics and keyboard protocols
- Drag files from the explorer or desktop into a terminal as shell-safe quoted paths
- The `oarlock` command in native terminal panes opens a file in the editor of the window it runs in
- Per-tab workspace environments on Windows (Local, or any installed WSL distro)
- Spaces restore tabs, working directories, and split layouts across launches

### Code editor

- CodeMirror 6 (supports all popular languages - TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON, Markdown, etc.)
- Inline AI autocomplete with local model support
- AI edit diffs, accept or reject hunk by hunk
- Opt-in language server support with diagnostics, navigation, completion, formatting, and custom servers
- Rendered Markdown plus image, video, audio, and PDF viewing
- Vim mode
- Built-in editor themes including Kanagawa, Catppuccin, Rosé Pine, Everforest, Dracula, Solarized, Nord, Tokyo Night, GitHub, and Xcode

### Source control

- Stage / unstage hunks, commit (Cmd+Enter / Ctrl+Enter), push with upstream awareness
- Branch display including detached HEAD state
- Git history pane with a real commit graph (lane rendering for merges and branches)
- Commit search and filter, click through to the remote commit page

### File explorer

- Catppuccin icon theme
- Fuzzy search, keyboard navigation, inline rename, context actions
- Live updates when files change on disk
- Attach files and selections directly to the AI side-panel

### Web preview

- Auto-detects local dev servers and opens them in a preview tab
- External URL preview via a native child webview

### Themes and customization

- Custom themes built in-app, switch between bundled presets and your own
- Create your own themes and share them as `.oarlock-theme` files, or import Ghostty, iTerm2, Alacritty and Windows Terminal color schemes
- Background images with adjustable opacity and blur
- Editor theme is independent from the app theme

### AI

- **BYOK providers:** OpenAI, Anthropic, Google (Gemini), Groq, xAI (Grok), Cerebras, OpenRouter, DeepSeek, Mistral, plus any OpenAI-compatible endpoint
- **Local / offline:** LM Studio, MLX, Ollama
- **Agentic workflow:** plans, sub-agents, file read / write / edit / multi-edit / grep / glob, bash with approval gating, background processes
- **Project instructions and skills:** a project's `AGENTS.md`, its skills (`.claude/skills`, `.oarlock/skills`) and its `.mcp.json` servers are used once you allow them, and asked about again when they change
- **MCP servers:** local and remote Model Context Protocol servers, each tool call approved unless you trust the server
- **Coding-agent orchestration:** spawn Claude Code in a terminal, inspect its output, and send follow-up work through approval-gated tools
- **Composer:** prompt snippets via `#handle`, files via `@path`, voice input, attach-to-agent from explorer or selection
- **Custom agents** with their own system prompt and tool subset
- **Plan mode** for multi-step work, generates and confirms before doing

## Install

There are no releases yet: until the first one, build Oarlock from source (below). Releases will be published on the [Releases](https://github.com/qopsc/oarlock/releases) page with builds for macOS and Linux; Windows builds from source. Updates are not set up yet, so a build does not update itself.

### Windows notes

- Default shell detection: `pwsh.exe` (PowerShell 7+) -> `powershell.exe` (Windows PowerShell 5.1) -> `cmd.exe`.
- WSL is a first-class workspace environment, not a wrapped subprocess.

### Linux notes

- **NixOS / Nix** (once the first release is out; the flake installs release builds): `nix profile install github:qopsc/oarlock` (non-NixOS), or import the flake and add `inputs.oarlock.packages.${pkgs.system}.oarlock` to `environment.systemPackages` (NixOS). The `nixosModules.oarlock` output is also available for a simpler setup.
- **AppImage:** needs FUSE. Without it: `./Oarlock_*.AppImage --appimage-extract-and-run`. On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Otherwise the `.deb` / `.rpm` packages link against the system GTK stack and tend to be smoother.

## Configure AI

1. Open **Settings -> AI**.
2. Pick a provider and paste your API key. For local inference, point Oarlock at your LM Studio / MLX / Ollama endpoint.
3. Keys go to the OS keychain (the macOS Keychain, the Windows Credential Manager); on Linux they go to a file in the app's data folder that only your user can read. They never go to localStorage or the logs.

## Build from source

**Prerequisites**
- Rust (stable), https://rustup.rs
- [Bun](https://bun.sh) 1.4.3+
- Tauri prerequisites for your platform, https://tauri.app/start/prerequisites/

**Run**
```bash
bun install
bun run tauri dev       # development
bun run tauri build     # production bundle
```

**Checks**
```bash
bun run lint
bun run check-types
bun run test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings   # Rust lint (matches CI)
cd src-tauri && cargo nextest run --locked                           # or: cargo test --locked
```

## Tech stack

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, Vite, libghostty-vt, WebGPU, CodeMirror 6, Vercel AI SDK v7, Tailwind v4, shadcn/ui, Zustand.

## Contributing

Issues and PRs are welcome! Feel free to open issues, suggest features, or submit pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) (the architecture guide) and the [architecture docs](docs/README.md) for more details.

## Based on Terax

Oarlock is based on [Terax](https://github.com/crynta/terax-ai) by Crynta, licensed under the Apache License 2.0. Oarlock is published by Quantum Ops Consulting, LLC, which has modified it; the git history records the changes.

## License

Oarlock is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for the attribution notices, including the third-party ones.
