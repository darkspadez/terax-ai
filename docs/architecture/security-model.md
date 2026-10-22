# Security model

This guide elaborates on `TERAX.md`. If anything here conflicts with `TERAX.md`, `TERAX.md` wins.

Terax runs shells, reads and writes files, and sends data to AI providers. The security model is defense-in-depth: no single guard is enough, so every boundary validates input before acting on it.

## Boundaries

The main trust boundaries are:

1. **IPC boundary** - commands registered in `src-tauri/src/lib.rs`, gated by `src-tauri/capabilities/default.json`.
2. **File-system boundary** - every file command, PTY and shell spawn, git and the AI tools go through the workspace authorization registry; AI tools also go through `src/modules/ai/lib/security.ts`.
3. **Network boundary** - AI HTTP proxy in `src-tauri/src/modules/net.rs` with SSRF and DNS-rebinding defenses.
4. **Secret-storage boundary** - keys live in the OS keychain, never on disk or in `localStorage`.
5. **Terminal escape-sequence boundary** - OSC sequences are parsed and acted on, but never blindly trusted to mutate state.

## Secret-path deny-list

`src/modules/ai/lib/security.ts` refuses reads and writes of obvious secret paths. This applies **on both read and write** and must never be bypassed.

Blocked categories include:

- Files: `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `known_hosts`, `credentials`, `service-account*.json`, and similar.
- Directories: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.config/gh`, `~/.git`, system dirs (`/etc`, `/proc`, `/sys`), and Windows credential stores.
- System write prefixes: `/etc/`, `/var/db/`, `/usr/bin/`, `/applications/`, `/windows/`, `/program files/`, etc.
- Home persistence points (write only, directly under a home root such as `/Users/<name>`, `/home/<name>`, `/var/home/<name>`, `/root` or `C:\Users\<name>`): shell rc and login files (`.zshrc`, `.bashrc`, `.profile`, ...), `.gitconfig`, `~/.config/{fish,autostart,systemd/user,environment.d}`, `~/Library/LaunchAgents`, PowerShell profile folders and the Windows Startup folder. They run code later as the user, outside any approval; the same names elsewhere (a dotfiles repo) stay writable. This is defense in depth: an approved shell command can still write them.

The comparison surface normalizes paths: backslashes to forward slashes, strips Windows drive letters, strips NTFS alternate data streams, strips trailing dots/spaces, lowercases, and collapses duplicate slashes. Protected directories are matched as exact path or descendant, not raw substring.

`checkReadableCanonical` and `checkWritableCanonical` also canonicalize the path and re-check the resolved form so a symlink at an innocent path pointing into `~/.ssh` is caught.

## Workspace authorization registry

`WorkspaceRegistry` (`src-tauri/src/modules/workspace.rs`) tracks the folders that file commands, PTY spawn, git commands, and AI tools are allowed to operate in.

- `workspace_authorize` adds a root, or with `opened` lets the file commands reach a folder the user browses or the folder a file they open is really in (`authorize_opened`; nothing is added when an authorized folder already covers it).
- `authorize_spawn_cwd` rejects a spawn cwd outside an authorized root.
- `authorize_user_spawn_cwd` registers the user's chosen cwd as a new root instead of rejecting it.
- The registry is bootstrapped with the launch directory and the user's home directory (`bootstrap_registry`).
- A launch (arguments, a later launch handed over by `tauri-plugin-single-instance`, macOS Open With) authorizes its folder and the folder each of its files is in before a window opens them (`second_launch::authorize_launch`). Only the user's own processes reach a running Terax (the session D-Bus on Linux, a window message on Windows, a socket in `/tmp` the user owns on macOS), and those could start Terax with the same arguments anyway.

### File commands

Every Tauri command that reads, writes, lists, stats, searches or watches a path the page sends is refused outside the authorized folders. The check is on the real path, through one of four gates:

- `authorized_existing`: the path, links followed and `..` resolved, lies in an authorized folder (`fs_read_file`, `fs_read_dir`, `list_subdirs`, `fs_stat`, `fs_canonicalize`, `fs_host_path` for WSL, the roots of `fs_search`, `fs_list_files`, `fs_grep`, `fs_grep_interactive` and `fs_glob`, `fs_open_default`, `lsp_resolve_root`).
- `authorized_write_target`: `fs_write_file` writes through a link only to an authorized file, a dangling link is an error, a new file needs an authorized folder.
- `authorized_new`: `fs_create_file` and `fs_create_dir` need the nearest existing ancestor authorized and plain names below it, so neither a link nor `..` leads out.
- `authorized_entry`: `fs_rename`, `fs_delete` and the sources of `fs_copy` act on the entry itself (a link, not what it points to) in an authorized folder; `..` and an authorized folder itself are refused. `fs_move` and `fs_delete_batch` also keep both ends under the explorer's authorized root.

A missing path outside reads as outside, so a refusal never says whether something exists there, and relative paths are refused. A WSL path is judged by its host path (the `\\wsl.localhost` share or the drive of `/mnt/<drive>`). `fs_watch_add` drops folders and files outside; `lsp_resolve_root` only looks into authorized folders, for markers that are plain names. Searches walk without following links, so a link inside a root never leads a search out.

The page authorizes only what the user chose (`src/modules/workspace/authorize.ts`): a file opened from the explorer, its search, the content search, a terminal link, LSP navigation or the New File dialog (its real folder); a folder expanded in the explorer; files dropped or pasted into the explorer (their folders, as host paths); the roots, terminal folders and open files of the spaces a window restores. It never authorizes a path a terminal program or an AI reply named on its own, so the AI tools (`read_file`, `list_directory`, `grep`, `glob`, writes) are refused outside the authorized folders, and `terax open` from a terminal already requires an authorized file. Path completion in the block input lists only authorized folders.

Two limits remain. `workspace_authorize` is itself a command the page can call, so the registry contains what the app's own flows do, not a fully compromised page. And a terminal's cwd reported by OSC 7 is authorized as a root, which keeps the explorer and Source Control following `cd` anywhere, but is terminal output: a program that prints an OSC 7 sequence can authorize a folder.

This is the allow side of the file-system boundary. Any new command that takes a path must pass it through one of these gates.

## Asset protocol scope

Asset URLs (`asset://localhost/...`, `http(s)://asset.localhost/...` on Windows) let a webview load a file from disk without IPC. `tauri.conf.json` allows nothing (`assetProtocol.scope` is `[]`, and a test keeps it so); `src-tauri/src/modules/asset_scope.rs` grants at runtime:

- every root the workspace registry authorizes, recursively, through `WorkspaceRegistry::watch_roots` (roots authorized before the app existed are replayed). The editor's media and PDF previews and the Markdown preview's images load from there. A WSL root is registered by its host path (the `\\wsl.localhost` share or the drive of a `/mnt/<drive>` path), which is also what `fs_host_path` maps a WSL file to for its URL. A root inside one already granted adds nothing, unless the way down passes a dot folder the wildcard skips.
- each installed font face `system_font_faces` returns, as a single file, for the terminal's font features.

Tauri canonicalizes every requested path before matching, so a link pointing out of a granted root is refused. The configured scope sets `requireLiteralLeadingDot`, so on every platform the wildcards never enter names starting with a dot and a granted home folder does not serve `~/.ssh` (Tauri's default does this only on Unix, which on Windows would serve `C:\Users\<me>\.ssh`). Never widen the configured scope (no `**`); grant what a feature needs where it needs it.

## Opening files in their default app

`fs_open_default` (`src-tauri/src/modules/fs/file.rs`) hands the OS only an existing file whose canonical path lies in an authorized workspace, so a link pointing out of the workspace is refused. The OS's default handler can run code, so the command classifies the canonical path first (`fs/launch.rs`, a pure function per OS: Windows extensions such as `.exe`, `.bat`, `.ps1`, `.js`, `.lnk`, `.reg`, an alternate data stream; on macOS and Linux the execute bit, Mach-O or ELF headers, bundles, Terminal scripts, launchers, installers and packages; Windows programs everywhere, since Wine may run them). The lists err toward asking. A program opens only when the call says the user confirmed it; otherwise the command answers `confirm` without opening anything, and the explorer's `RunProgramDialog` names the file and asks before calling again. A link named like a document is judged by its target.

## AI tool approval flow

In `src/modules/ai/tools/tools.ts`:

- `TOOL_GATES` classifies every tool (`none`, `approvable`, `approvable-outside-plan`, `always`); the record is exhaustive, so a new tool cannot ship unclassified. Each run's `toolApproval` is built from it and the conversation's approval mode (`buildToolApproval`, read on every call); sub-agents get Ask mode's fixed `TOOL_APPROVAL`.
- Read-only tools (`read_file`, `list_directory`, `grep`, `glob`) auto-execute after passing the deny-list.
- In Ask mode (the default), mutating tools (`write_file`, `edit`, `multi_edit`, `create_directory`, `bash_run`, `bash_background`) and the coding-agent tools (`spawn_coding_agent`, `send_to_agent`) are `user-approval`. The AI SDK pauses and surfaces a `tool-approval-request` part rendered as a confirmation card.
- Auto-approve, a per-conversation opt-in shown by an always-visible composer chip, runs file and shell tools without the card. It only drops the card: `execute` still refuses protected paths and the command deny-list, plan mode keeps shell commands asking, and the coding-agent tools, which no deny-list covers, ask in every mode.
- Plan mode queues file mutations instead; Apply re-checks each path against the deny-list where it writes.
- `edit` / `multi_edit` enforce a read-before-edit invariant: the model must have read the file earlier in the session.

Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`.

## SSRF and DNS rebinding defense

`src-tauri/src/modules/net.rs` proxies AI provider requests and local-model pings. Before connecting:

1. Resolve the hostname once (`resolve_and_classify`).
2. Classify every resolved IP as public, private, loopback, or blocked metadata (`net/ip.rs`). An IPv6 address that carries an IPv4 destination (`::ffff:a.b.c.d`, `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo) takes the class of the embedded IPv4, and anything outside global unicast `2000::/3` (unique-local, site-local, link-local, multicast, documentation) is never public. Redirect targets are classified the same way.
3. Block cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, AWS IPv6 metadata, etc.).
4. Pin reqwest to the resolved IPs so a second DNS lookup cannot return a different address (DNS rebinding).

Local LLM endpoints are explicitly allowed because the user opted in by pointing Terax at them, but they are still classified and logged.

The Markdown preview's remote images go through the same checks (`net/image.rs`): https only, public addresses only, and redirects are followed by hand so every hop is validated, classified and pinned again. The webview's CSP loads no remote images at all, because AI chat Markdown renders in the same webview and an image URL in a prompt-injected answer would send data out without a click; only the preview of a file the user opened asks the backend for its images.

Formulas and diagrams in that Markdown are untrusted too. KaTeX runs with `trust` off, so `\href`, `\url`, `\includegraphics` and the `\html*` extensions render as errors, never as links or markup. Mermaid runs at its strict security level with labels as SVG text, and a diagram's own `%%{init}%%` directive or front matter cannot turn HTML labels, DOMPurify settings, theme CSS or fonts back on (`MERMAID_SECURE_KEYS`); links are removed from its output so a click never navigates the webview, and an image shape's remote URL falls to the same CSP (`src/modules/markdown/mermaidRender.ts`, `mathPlugin.ts`).

## Secret storage

API keys are stored via `secrets_*` commands (`src-tauri/src/modules/secrets.rs`):

- macOS: Keychain via `keyring`
- Windows: Credential Manager via `keyring`
- Linux: a JSON file in the app's local data dir with mode `0600` (atomic write to `.tmp` then rename)

Service constant: `terax-ai`. Keys never touch disk outside the keychain/Linux secrets file, never go in `localStorage`, and never appear in logs.

## OSC trust gating

The terminal parses OSC sequences from the PTY byte stream:

- **OSC 7** updates the tab cwd.
- **OSC 133 A/B/C/D** marks prompt/command boundaries.
- **OSC 777** is used by the agent detector to signal coding-agent state transitions.

The agent detector (`src-tauri/src/modules/pty/agent_detect.rs`) is armed by `OSC 133;C;<cmd>` or by a self-armed marker and emits `terax:agent-signal` events. It is driven **only by OSC sequences**, never by raw output, so a repainting TUI never flaps. The agent name a marker carries is untrusted: any name is shown, but only as plain text with control and bidi characters removed and at most 32 characters, with the generic icon unless it is exactly a known agent id. It never selects a command, path, hook file or icon file.

## Invariants

- The deny-list in `security.ts` applies on both read and write. Never bypass it.
- New file-system-touching commands must pass every path the page sends through a registry gate (`authorized_existing`, `authorized_write_target`, `authorized_new`, `authorized_entry`).
- The page authorizes a path only for what the user chose, never for a path a terminal program or an AI reply named.
- The asset protocol's configured scope stays empty; files are granted at runtime (`asset_scope.rs`), never with `**`.
- New network-facing commands must go through the `net.rs` proxy or reimplement the same classification and DNS pinning.
- New plugin APIs must be added to `src-tauri/capabilities/default.json`.
- Keys, tokens, and credentials stay in the keychain / Linux secrets file.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [AI subsystem](ai-subsystem.md) - tools, approval flow, and provider handling
