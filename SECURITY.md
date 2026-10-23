# Security

Terax runs shells, reads/writes files, and talks to AI providers, so security bugs matter. If you find one, please tell us before posting it publicly.

## Reporting

Report it privately through [GitHub's security advisory form](https://github.com/darkspadez/terax-ai/security/advisories/new). Include:

- What the issue is and what it lets an attacker do
- Steps to reproduce (a small PoC is great)
- Version, OS, arch

We'll get back to you within a few days. Once it's fixed, we'll credit you in the release notes - unless you'd rather stay anonymous.

Please **don't** open a public GitHub issue for security reports.

## Supported versions

Until `1.0.0`, only the latest minor gets security fixes. See the current version in `package.json` or on the [Releases page](https://github.com/darkspadez/terax-ai/releases). 

## What's in scope

- The Rust backend in `src-tauri/` (PTY, FS, IPC, plugins)
- The frontend in `src/` - anywhere untrusted input lands (terminal output, file content, AI tool results, credentials)
- Release artifacts on this repository's GitHub Releases
- The auto-updater

## What's not

- Bugs in upstream deps (Tauri, Ghostty, CodeMirror, AI SDKs…) - report those upstream. We'll ship the fix once it's released.
- Anything that needs an already-compromised machine or a local attacker with shell access
- Older versions (`< 0.5`)

## What we do to keep things safe

- **API keys** live in the OS keychain via `keyring` - not on disk, not in `localStorage`, not in logs.
- **No telemetry.** Terax only talks to the network when you ask it to (AI requests, update checks, web preview).
- **AI tool approval.** File writes and shell commands from the agent need your OK before they run, unless you turn on Auto-approve for a chat (an always-visible chip shows it). Launching or messaging a coding agent always asks, and no mode skips the path and command deny-lists.
- **MCP servers ask first.** A tool from an MCP server you added asks before every call, even in Auto-approve, unless you mark that server Trusted; what a server says about its tools never changes that. What servers return is treated as untrusted. Remote servers are reached only at the address you configured, through the same network checks as AI requests, and their secret headers and the secret environment variables of local servers stay in your keychain, out of reach of Terax's pages.
- **No Node in the renderer.** The frontend only reaches the host through the allow-listed Tauri commands.
- **Files stay in your folders.** Terax's file commands read, write and list only inside folders you opened or browsed (and the folders of files you opened), judged on the real path, so a link or `..` cannot lead out. The agent's file tools are refused anywhere else. A terminal's folder joins them as you `cd`, but on Linux and macOS only once the OS confirms the shell is really there, so a program printing a fake folder report cannot add one.
- **Lifting the folder limit is your call, one side at a time.** Settings has two switches, both off by default and marked "At your own risk": one lets the app's own file features (explorer, editor, previews, search) work in any folder, the other lets the agent's file and shell tools do so. Neither widens the other, the agent's secret-file deny-list (`~/.ssh`, `.env`, keys) and approvals still apply, and previews never serve dot folders. While either is on, Settings shows it, and the agent's switch shows in the chat composer too. They are ordinary settings, so anything that can drive Terax's own pages could turn them on.
- **Settings stay in Terax's folder.** The page can open its settings stores only by plain names inside Terax's own data folder, never a path elsewhere on disk.
- **Programs ask first, natively.** Open in Default App runs a program or script only after you confirm in your OS's own dialog, which nothing in the app's pages can answer. Return and Escape answer Cancel there, so running takes a click on Run.
- **Signed releases.** Updates are verified before they're applied.

## What we can't promise

- Terax runs whatever you (or the agent) tell it to run, with your permissions. That's kind of the point of a terminal.
- MCP servers you add are programs and services you chose: a local one runs as you, outside Terax's folder limits, and a remote one sees what the agent sends it. Only add servers you trust.
- AI providers see whatever you send them. Read their retention policies.
- Local LLM endpoints (LM Studio, OpenAI-compatible) are trusted at the network level - only point Terax at servers you control.
