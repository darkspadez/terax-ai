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

`src/modules/ai/lib/security.ts` refuses reads and writes of obvious secret paths. This applies **on both read and write**, also while "Allow AI tools to access all folders" is on (it consults no setting), and must never be bypassed.

Blocked categories include:

- Files: `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `known_hosts`, `credentials`, `service-account*.json`, and similar.
- Directories: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.config/gh`, `~/.git`, system dirs (`/etc`, `/proc`, `/sys`), and Windows credential stores.
- System write prefixes: `/etc/`, `/var/db/`, `/usr/bin/`, `/applications/`, `/windows/`, `/program files/`, etc.
- Home persistence points (write only, directly under a home root such as `/Users/<name>`, `/home/<name>`, `/var/home/<name>`, `/root` or `C:\Users\<name>`): shell rc and login files (`.zshrc`, `.bashrc`, `.profile`, ...), `.gitconfig`, `~/.config/{fish,autostart,systemd/user,environment.d}`, `~/Library/LaunchAgents`, PowerShell profile folders and the Windows Startup folder. They run code later as the user, outside any approval; the same names elsewhere (a dotfiles repo) stay writable. This is defense in depth: an approved shell command can still write them.

The comparison surface normalizes paths: backslashes to forward slashes, strips Windows drive letters, strips NTFS alternate data streams, strips trailing dots/spaces, lowercases, and collapses duplicate slashes. Protected directories are matched as exact path or descendant, not raw substring.

`checkReadableCanonical` and `checkWritableCanonical` also canonicalize the path and re-check the resolved form so a symlink at an innocent path pointing into `~/.ssh` is caught. A path that cannot be resolved is let through only when it does not exist (the OS's not-found error, `isNotFoundError`); any other failure (outside the authorized folders, no permission, a link loop) refuses, since the read or write would follow links the recheck never saw.

## Workspace authorization registry

`WorkspaceRegistry` (`src-tauri/src/modules/workspace.rs`) tracks the folders that file commands, PTY spawn, git commands, and AI tools are allowed to operate in.

- `workspace_authorize` adds a root, or with `opened` lets the file commands reach a folder the user browses or the folder a file they open is really in (`authorize_opened`; nothing is added when an authorized folder already covers it).
- `authorize_spawn_cwd` rejects a spawn cwd outside an authorized root.
- `authorize_user_spawn_cwd` registers the user's chosen cwd as a new root instead of rejecting it.
- The registry is bootstrapped with the launch directory and the user's home directory (`bootstrap_registry`).
- A launch (arguments, a later launch handed over by `tauri-plugin-single-instance`, macOS Open With) authorizes its folder and the folder each of its files is in before a window opens them (`second_launch::authorize_launch`). Only the user's own processes reach a running Terax (the session D-Bus on Linux, a window message on Windows, a socket in `/tmp` the user owns on macOS), and those could start Terax with the same arguments anyway.

### File commands

Every Tauri command that reads, writes, lists, stats, searches or watches a path the page sends is refused outside the authorized folders, unless its caller's "access all folders" switch is on (below). The check is on the real path, through one of four gates:

- `authorized_existing`: the path, links followed and `..` resolved, lies in an authorized folder (`fs_read_file`, `fs_read_dir`, `list_subdirs`, `fs_stat`, `fs_canonicalize`, `fs_host_path` for WSL, the roots of `fs_search`, `fs_list_files`, `fs_grep`, `fs_grep_interactive` and `fs_glob`, `fs_open_default`, `lsp_resolve_root`).
- `authorized_write_target`: `fs_write_file` writes through a link only to an authorized file, a dangling link is an error, a new file needs an authorized folder.
- `authorized_new`: `fs_create_file` and `fs_create_dir` need the nearest existing ancestor authorized and plain names below it, so neither a link nor `..` leads out.
- `authorized_entry`: `fs_rename`, `fs_delete` and the sources of `fs_copy` act on the entry itself (a link, not what it points to) in an authorized folder; `..` and an authorized folder itself are refused. `fs_move` and `fs_delete_batch` also keep both ends under the explorer's authorized root.

A missing path outside reads as outside, so a refusal never says whether something exists there, and relative paths are refused. A WSL path is judged by its host path (the `\\wsl.localhost` share or the drive of `/mnt/<drive>`). `fs_watch_add` drops folders and files outside; `lsp_resolve_root` only looks into authorized folders, for markers that are plain names. Searches walk without following links, so a link inside a root never leads a search out.

The page authorizes only what the user chose (`src/modules/workspace/authorize.ts`): a file opened from the explorer, its search, the content search, a terminal link, LSP navigation or the New File dialog (its real folder); a folder expanded in the explorer; files dropped or pasted into the explorer (their folders, as host paths); the roots, terminal folders and open files of the spaces a window restores. It never authorizes a path a terminal program or an AI reply named on its own, so the AI tools (`read_file`, `list_directory`, `grep`, `glob`, writes) are refused outside the authorized folders, and `terax open` from a terminal already requires an authorized file. Path completion in the block input lists only authorized folders.

A terminal's folder is authorized as a root, which keeps the explorer and Source Control following `cd` anywhere. The folder comes from OSC 7, which is terminal output: `cat` of a crafted file can print one naming any folder, even `/`. So the page hands each report to `pty_authorize_cwd` with the terminal's id (only the window that opened the terminal may ask), and on Linux and macOS the backend authorizes it only when its real path is exactly the folder the OS reports for the shell (`/proc/<pid>/cwd`; `proc_pidinfo` with `PROC_PIDVNODEPATHINFO`) or for the leader of the terminal's foreground process group (a nested local shell, such as `bash` started from zsh, reports its own folder), both canonical and checked to still be the folder the process is in (a deleted folder never matches). The report follows the `cd`, so the shell is already there; one that a fast second `cd` overtook authorizes nothing, and the next report is checked. A report that does not match changes nothing in the page either (`TerminalCwdReports`): not the tab's folder, the explorer or Source Control, the folder a restart or a new tab starts in, or the terminal folders a restored window authorizes, since each of those would authorize it later. One check runs at a time per terminal and a burst keeps its latest report. A remote shell's report (over `ssh`) names no local process's folder, so the tab keeps the local folder `ssh` runs in. Windows cannot read another process's folder cheaply, so there (a WSL pane included) the report is authorized and taken as before.

One limit remains: `workspace_authorize` is itself a command the page can call, so the registry contains what the app's own flows do, not a fully compromised page. The same holds for the two settings below: they are plain switches in Settings, so the page can turn them on (`workspace_set_all_folders`).

### Access to all folders

Settings, General, Folder access has two switches, both off by default and labelled "At your own risk": **Allow the app to access all folders** and **Allow AI tools to access all folders**. They are independent: each widens one side and never the other.

- The backend holds them (`WorkspaceRegistry::set_all_folders`, both off until told). Every window sends the stored values when its preferences load and each change it sees, whichever window made it (`src/modules/workspace/allFolders.ts`, from `usePreferencesStore.init`), so the gates follow a switch from the next command on.
- A command that both sides use takes an `origin` (`Origin`, `app` or `ai`): `fs_read_file`, `fs_write_file`, `fs_canonicalize`, `fs_create_dir`, `fs_read_dir`, `fs_grep`, `fs_glob`, `shell_run_command` (its cwd), `shell_session_open`, `shell_session_run` and `shell_bg_spawn`. A call that leaves it out is the app's. The AI tools' wrappers (`src/modules/ai/lib/native.ts`) send `ai` on every file and shell call, so the agent never gets the app's access, and a test checks that each command they tag takes the parameter (otherwise the tag would be dropped silently). Every other file command is the app's alone.
- The command takes its gates once (`registry.gates(origin)`): the authorized folders, or every folder while that origin's switch is on. The gates still require an absolute path judged on its real path, plain names for new entries and below an explorer root, and still read a missing path as outside while closed. Turning a switch off refuses the next command.
- A switch authorizes nothing: no root is added, so the other side, the asset protocol's grants, git, language servers (`lsp_resolve_root`, spawn cwd), terminal folders (`pty_authorize_cwd`) and `terax open` keep the authorized folders (`registry.authorized_gates()`, `is_authorized`). The page still authorizes what the user opens, as with the switches off, so turning one off leaves what the user chose reachable.
- The app's switch covers the explorer (listing, create, rename, move, delete, copy), editor open and save (and the external formatter's cwd), previews, the file finder and content search, file watching, path completion in block terminals and Open in Default App, whose question before running a program stays. Watches set up while it was on keep reporting changes until released.
- The AI tools' switch covers `read_file`, `list_directory`, `grep`, `glob`, `write_file`, `edit`, `multi_edit`, `create_directory`, plan mode's Apply and the agent shell's cwd. The deny-list and tool approval (Ask, Auto-approve) are unchanged, and the composer shows an "All folders" chip while it is on. Settings shows a persistent indicator in its header while either is on.

This is the allow side of the file-system boundary. Any new command that takes a path must pass it through one of these gates.

## Settings store

The page keeps its settings, preferences, chat list, snippets, todos, agents, custom themes and spaces in JSON stores through `tauri-plugin-store` (`store:default`). The plugin joins the path the page gives it to the app data folder, so an absolute path or `..` would read or write JSON anywhere, and it has no option to stop that. `src-tauri/src/modules/store_scope.rs` registers the plugin inside a thin wrapper that forwards every hook unchanged (stores, resource ids, the `store://change` events that keep windows in sync, file names) and refuses, before the plugin sees them, the two commands that name a file (`load`, `get_store`) unless the name is a plain file name: ASCII letters, digits, `-`, `_` and inner dots, no separator, drive, `..`, leading or trailing dot, or Windows device name (`CON`, `NUL.json`). The only nested name allowed is an extra window's own spaces store, `windows/<label>/terax-spaces.json`, from that window alone. Every other store command takes the resource id of a store opened that way. A test lists every store the page opens (each `STORE_PATH` in `src/`) and checks that each is allowed. The backend's own stores (`StoreExt`) are not affected.

## Asset protocol scope

Asset URLs (`asset://localhost/...`, `http(s)://asset.localhost/...` on Windows) let a webview load a file from disk without IPC. `tauri.conf.json` allows nothing (`assetProtocol.scope` is `[]`, and a test keeps it so); `src-tauri/src/modules/asset_scope.rs` grants at runtime:

- every root the workspace registry authorizes, recursively, through `WorkspaceRegistry::watch_roots` (roots authorized before the app existed are replayed). The editor's media and PDF previews and the Markdown preview's images load from there. A WSL root is registered by its host path (the `\\wsl.localhost` share or the drive of a `/mnt/<drive>` path), which is also what `fs_host_path` maps a WSL file to for its URL. A root inside one already granted adds nothing, unless the way down passes a dot folder the wildcard skips.
- each installed font face `system_font_faces` returns, as a single file, for the terminal's font features.

Tauri canonicalizes every requested path before matching, so a link pointing out of a granted root is refused. The configured scope sets `requireLiteralLeadingDot`, so on every platform the wildcards never enter names starting with a dot and a granted home folder does not serve `~/.ssh` (Tauri's default does this only on Unix, which on Windows would serve `C:\Users\<me>\.ssh`). Never widen the configured scope (no `**`); grant what a feature needs where it needs it.

A runtime grant can never be taken back, so "Allow the app to access all folders" grants nothing here. While it is on, previews load through the backend's own `terax-asset` scheme instead (`src-tauri/src/modules/asset_all_folders.rs`; `workspaceAssetUrl` picks the scheme from the setting this window last sent). It asks the setting on every request: it serves what the asset protocol would, and while the switch is on any file whose real path has no name starting with a dot (the rule `requireLiteralLeadingDot` applies below a granted root, here from the filesystem root), so `~/.ssh`, `.env` and `.git` stay out. Links are judged by their target, a missing file outside reads as refused, only GET and HEAD with single byte ranges (at most 1000 KiB a response) are answered, responses are `no-store` and name only the app's origin, and a request carrying any other `Origin` is refused. Like the asset protocol, any frame can load from it (a page in the preview pane can show, but not read, such a file while the switch is on). The moment the switch is off it serves no more than the asset protocol, and previews switch back to `asset:` URLs.

## Opening files in their default app

`fs_open_default` (`src-tauri/src/modules/fs/file.rs`) hands the OS only an existing file whose canonical path lies in an authorized workspace, so a link pointing out of the workspace is refused. The OS's default handler can run code, so the command classifies the canonical path first (`fs/launch.rs`, a pure function per OS: Windows extensions such as `.exe`, `.bat`, `.ps1`, `.js`, `.lnk`, `.reg`, an alternate data stream; on macOS and Linux the execute bit, Mach-O or ELF headers, bundles, Terminal scripts, launchers, installers and packages; Windows programs everywhere, since Wine may run them). The lists err toward asking. For a program the backend shows the OS's own dialog (`fs/run_prompt.rs`: a warning naming the file and saying it runs as a program, Cancel and Run, attached to the calling window) and opens the file only on Run; otherwise it answers `cancelled`. Return presses Cancel on every platform, so running takes a deliberate click on Run (or moving the focus to it first), and Escape or closing the dialog cancels: on macOS an `NSAlert` sheet whose first, accented button is Cancel with Return as its key (Run has none; Escape, which `NSAlert` would give only to a Cancel button that is not the default, is caught while the sheet is up and presses Cancel, and the keyboard-navigation focus starts on Cancel); on Windows `TaskDialogIndirect` with Run and Cancel and Cancel the default, focused button; on Linux a `GtkMessageDialog` transient for the window with Cancel the default response and focused. tauri-plugin-dialog cannot choose the default button (through rfd its first button is the default on macOS and Windows, and GTK gets none), and handing it the labels in the other order is unsafe, because it reports a dialog closed any other way as its second button. Only an explicit Run runs: any other answer, a dialog that never showed or one destroyed with its window is a Cancel. The page has no way to approve: the command takes no confirmation, the webview holds no permission for message dialogs, and the answer arrives from the OS. Only one such question shows at a time, the dialog is awaited without blocking the main thread, and the file is checked again after the answer. A link named like a document is judged by its target.

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

## Language server docs

Hover and completion docs come from the language server, which takes them from comments in the project and its dependencies. The LSP library renders them with `marked.parse` into `innerHTML`, so `src/modules/lsp/lib/safeMarkdown.ts` sets that shared `marked` instance's renderer when the LSP client loads: raw HTML in the docs is shown as text (no iframes, forms or styles), links keep only `http`, `https` and `mailto` targets and open in the browser through the opener plugin (`target="_blank"`), never in the app's window, and images become their alt text.

## OSC trust gating

The terminal parses OSC sequences from the PTY byte stream:

- **OSC 7** updates the tab cwd, only between commands and, on Linux and macOS, only once the backend has matched it to the folder the shell or its foreground job is in (see the registry above).
- **OSC 133 A/B/C/D** marks prompt/command boundaries.
- **OSC 777** is used by the agent detector to signal coding-agent state transitions.

The agent detector (`src-tauri/src/modules/pty/agent_detect.rs`) is armed by `OSC 133;C;<cmd>` or by a self-armed marker and emits `terax:agent-signal` events. It is driven **only by OSC sequences**, never by raw output, so a repainting TUI never flaps. The agent name a marker carries is untrusted: any name is shown, but only as plain text with control and bidi characters removed and at most 32 characters, with the generic icon unless it is exactly a known agent id. It never selects a command, path, hook file or icon file.

## macOS privacy controls

macOS privacy controls (TCC) sit below the registry: a folder the registry authorizes can still be refused by macOS, and TCC counts Terax and every program its terminals start as one app. Checking what Terax may reach never makes macOS ask: the status check (`mac_privacy.rs`) opens only files that Full Disk Access guards, which macOS refuses silently (`EPERM`) without that grant, and never the folders macOS asks about (Desktop, Documents, Downloads, iCloud Drive, removable and network volumes, other apps' containers). The page opens System Settings only at a pane the backend names (`SettingsPane`), never at a URL it supplies, so the opener's URL scope stays as it is.

## Invariants

- The deny-list in `security.ts` applies on both read and write. Never bypass it.
- New file-system-touching commands must pass every path the page sends through a registry gate (`authorized_existing`, `authorized_write_target`, `authorized_new`, `authorized_entry`).
- The page authorizes a path only for what the user chose, never for a path a terminal program or an AI reply named. A terminal's reported folder is authorized only by `pty_authorize_cwd`, which on Linux and macOS requires the OS to confirm the shell or its foreground job is there.
- The asset protocol's configured scope stays empty; files are granted at runtime (`asset_scope.rs`), never with `**`. Files outside the grants are served only by `terax-asset`, only while the app may access all folders, and never under a dot name.
- The "access all folders" switches widen only their own side: a command both use takes `origin`, the AI tools send `ai` on every file and shell call, a call without it is the app's, and neither switch authorizes a root.
- The page opens stores by plain names in the app data folder only (`store_scope.rs`); a new store gets a plain name.
- New network-facing commands must go through the `net.rs` proxy or reimplement the same classification and DNS pinning.
- New plugin APIs must be added to `src-tauri/capabilities/default.json`.
- Keys, tokens, and credentials stay in the keychain / Linux secrets file.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [AI subsystem](ai-subsystem.md) - tools, approval flow, and provider handling
