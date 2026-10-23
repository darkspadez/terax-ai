# Security

Oarlock runs shells, reads/writes files, and talks to AI providers, so security bugs matter. If you find one, please tell us before posting it publicly.

## Reporting

Report it privately through [GitHub's security advisory form](https://github.com/qopsc/oarlock/security/advisories/new). Include:

- What the issue is and what it lets an attacker do
- Steps to reproduce (a small PoC is great)
- Version, OS, arch

We'll get back to you within a few days. Once it's fixed, we'll credit you in the release notes - unless you'd rather stay anonymous.

Please **don't** open a public GitHub issue for security reports.

## Supported versions

Until `1.0.0`, only the latest minor gets security fixes. See the current version in `package.json` or on the [Releases page](https://github.com/qopsc/oarlock/releases). 

## What's in scope

- The Rust backend in `src-tauri/` (PTY, FS, IPC, plugins)
- The frontend in `src/` - anywhere untrusted input lands (terminal output, file content, AI tool results, credentials)
- Release artifacts on this repository's GitHub Releases
- The updater, once updates are set up (they are not in current builds)

## What's not

- Bugs in upstream deps (Tauri, Ghostty, CodeMirror, AI SDKs…) - report those upstream. We'll ship the fix once it's released.
- Anything that needs an already-compromised machine or a local attacker with shell access

## What we do to keep things safe

- **API keys** live in the OS keychain via `keyring` - not on disk, not in `localStorage`, not in logs.
- **No telemetry.** Oarlock only talks to the network when you ask it to (AI requests, update checks, web preview).
- **AI tool approval.** File writes and shell commands from the agent need your OK before they run, unless you turn on Auto-approve for a chat (an always-visible chip shows it). Launching or messaging a coding agent always asks, and no mode skips the path and command deny-lists.
- **MCP servers ask first.** A tool from an MCP server you added asks before every call, even in Auto-approve, unless you mark that server Trusted; what a server says about its tools never changes that. What servers return is treated as untrusted, and so are the resources you attach and the prompts you run from them: the AI is told they are the server's words. When a server asks to use your AI model (sampling) or asks you for information, nothing happens until you approve it, in any mode and even for a trusted server: you can edit the request, Oarlock sends none of your conversation, and you see the model's reply before it goes back. Remote servers are reached only at the address you configured, through the same network checks as AI requests, and their secret headers and the secret environment variables of local servers stay in your keychain, out of reach of Oarlock's pages.
- **MCP sign-in stays in the backend.** Signing in to a remote server (OAuth) runs in Oarlock's backend: your browser opens the server's sign-in page and comes back to a one-time listener on `127.0.0.1`, the response is checked (`state`, PKCE, the issuer), and the tokens go to your keychain, bound to that server's address. Oarlock adds them to that server's requests itself; no page, and so no agent, ever sees one. Only Settings can sign in or out, and sign-in requests reach only the addresses the server's own metadata names, over https, through the same network checks.
- **Imported and project servers wait for you.** Servers imported from other apps start disabled and untrusted, and values that look like secrets go straight from those apps' files to your keychain. A project's `.mcp.json` is used only after you allow its current content in a prompt that lists every command and URL, and it asks again when the file changes outside Oarlock (your own edits in Oarlock, and the agent's you approved, keep your answer); its servers are never trusted automatically, a server you marked Trusted or whose tools you always allow asks again when its own entry changes, whoever changed it, and they stop when you close the project, withdraw your answer, or their own entry changes (an edit you allowed elsewhere in the file leaves them running).
- **Project instructions wait for you.** A project's `AGENTS.md` (instructions Oarlock adds to every AI run in it) is used only after you allow its current content, in the same prompt as the project's skills and `.mcp.json`, which shows its size and first lines (the AI gets the whole file, however large). A change made outside Oarlock (a `git pull`, another editor, a shell command, a coding agent) asks again; your own edits in Oarlock, and the agent's edits you approved or ran in Auto-approve, keep your answer. The same goes for a project's skills.
- **No Node in the renderer.** The frontend only reaches the host through the allow-listed Tauri commands.
- **Files stay in your folders.** Oarlock's file commands read, write and list only inside folders you opened or browsed (and the folders of files you opened), judged on the real path, so a link or `..` cannot lead out. The agent's file tools are refused anywhere else. A terminal's folder joins them as you `cd`, but on Linux and macOS only once the OS confirms the shell is really there, so a program printing a fake folder report cannot add one.
- **Lifting the folder limit is your call, one side at a time.** Settings has two switches, both off by default and marked "At your own risk": one lets the app's own file features (explorer, editor, previews, search) work in any folder, the other lets the agent's file and shell tools do so. Neither widens the other, the agent's secret-file deny-list (`~/.ssh`, `.env`, keys) and approvals still apply, and previews never serve dot folders. While either is on, Settings shows it, and the agent's switch shows in the chat composer too. They are ordinary settings, so anything that can drive Oarlock's own pages could turn them on.
- **Settings stay in Oarlock's folder.** The page can open its settings stores only by plain names inside Oarlock's own data folder, never a path elsewhere on disk.
- **Programs ask first, natively.** Open in Default App runs a program or script only after you confirm in your OS's own dialog, which nothing in the app's pages can answer. Return and Escape answer Cancel there, so running takes a click on Run.
- **No unsigned updates.** Updates are not set up in current builds; when they are, an update is verified against Oarlock's signing key before it is applied.

## What we can't promise

- Oarlock runs whatever you (or the agent) tell it to run, with your permissions. That's kind of the point of a terminal.
- A project's `AGENTS.md` steers what the agent does, and in Auto-approve its edits and commands run without asking. Only allow it in projects you trust.
- MCP servers you add (or import, or allow from a project) are programs and services you chose: a local one runs as you, outside Oarlock's folder limits, and a remote one sees what the agent sends it. Only add servers you trust, and only allow a project's `.mcp.json` when you trust the project.
- AI providers see whatever you send them. Read their retention policies.
- Local LLM endpoints (LM Studio, OpenAI-compatible) are trusted at the network level - only point Oarlock at servers you control.
