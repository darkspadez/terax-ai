# AI subsystem

This guide elaborates on `TERAX.md`. If anything here conflicts with `TERAX.md`, `TERAX.md` wins.

## Overview

The AI subsystem is BYOK (bring your own key). It supports cloud providers via `@ai-sdk/*` and local / offline providers via OpenAI-compatible endpoints. The agent layer is built on Vercel AI SDK v7 chat semantics: `streamText`, tool definitions, a `toolApproval` policy, and `stopWhen` step limits.

Main entry point: `runAgentStream` in `src/modules/ai/lib/agent.ts`.

## Providers

Cloud providers are defined in `src/modules/ai/config.ts`:

- OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter
- `openai-compatible` for any custom base URL
- Local: LM Studio, MLX, Ollama

`buildLanguageModel` in `src/modules/ai/lib/agent.ts` branches on `provider` to construct the correct AI SDK provider instance. Local providers use `createOpenAICompatible` with a `localProxyFetch` that allows private-network access, while cloud providers use their dedicated SDK constructors.

Model metadata (context limits, costs, reasoning behavior) lives in the model registry in `config.ts`. `resolveModel` maps a model id to its provider and defaults.

Custom endpoints also use `createOpenAICompatible` and `localProxyFetch`; cloud providers use the webview's own fetch. Anthropic refuses the CORS preflight of a browser origin unless the client sends `anthropic-dangerous-direct-browser-access: true`, so its branch always does. Cloud providers stay on the webview's fetch because the native proxy refuses non-public addresses, which fake-IP proxy tools (198.18.0.0/15) hand out for every host, and does not read the macOS system proxy. The cost is that an error reply without CORS headers (OpenAI's 401 for a bad key) reads as a network failure; `formatAiError` (`lib/errors.ts`) says so instead of showing the bare `Load failed` / `Failed to fetch`. A custom endpoint on `opencode.ai` over HTTPS (OpenCode Go/Zen) also gets the `x-opencode-session` header the gateway requires, with one random key per app run (`lib/opencodeSession.ts`). Custom endpoints and local servers move `<think>...</think>` out of the answer into reasoning (`extractReasoningMiddleware`). Streams that alternate `reasoning_content` and `content` (MiniMax) produce several reasoning and text parts per step; the chat shows each run of them between step starts and tool calls as one reasoning block and one text (`mergeInterleavedReasoning` in `lib/reasoningDisplay.ts`, display only).

A selectable model id is a catalog id, a local server's placeholder (`ollama-local`, resolved to its configured model id) or a custom endpoint's `compat-<endpointId>`. Every surface builds it with `buildConfiguredLanguageModel`: the chat from its transport getters, everything else (sub-agents, commit messages) with `liveModelConfig()` (`store/modelConfig.ts`), which carries the endpoints and their keys, so no caller can leave out what a custom endpoint needs. `modelConfigProblem` (`lib/modelTarget.ts`, free of the AI SDK) makes the same checks without building, to gate an action. Persisted ids (default model, favorites, recents) survive a restart when `isResolvableModelId` accepts them: a catalog id, or an endpoint that still exists and is complete. The legacy single endpoint is migrated under the fixed id `legacy`, and an empty saved endpoint list is never migrated again. In Settings, the Model ID of a custom endpoint or local server can be picked from the server's `GET <base>/models` list (Browse, `lib/endpointModels.ts`, through the native proxy with the endpoint's key). The Add provider menu also lists endpoint presets (`lib/endpointPresets.ts`), which add an ordinary custom endpoint with its name and base URL filled: OpenCode Go uses `https://opencode.ai/zen/go/v1`, so its requests carry the session header above and its models come from that list. A model the gateway documents only for another API (Anthropic Messages, OpenAI Responses, Google) may not answer through this OpenAI-compatible endpoint.

### Adding a new provider

1. Add a `ProviderInfo` entry to `PROVIDERS` in `src/modules/ai/config.ts`.
2. Add model ids and metadata to the model registry in the same file.
3. Add a case to the `switch (provider)` in `buildLanguageModel` (`src/modules/ai/lib/agent.ts`) that constructs the provider instance. For OpenAI-compatible APIs you can often reuse `createOpenAICompatible`.
4. If the provider requires an API key, update `providerNeedsKey` in `config.ts` and the keyring service mapping.
5. If it needs a dedicated `@ai-sdk/*` package, add it to `package.json` and justify the bundle cost (see `CONTRIBUTING.md`).
6. New built-ins must justify unique value beyond `openai-compatible` and OpenRouter; `CONTRIBUTING.md` calls this out explicitly.

Keys are never persisted outside the OS keychain / Linux secrets file.

## Agent run loop

`runAgentStream` (`agent.ts`):

1. Resolves the model via `buildConfiguredLanguageModel`.
2. Builds a stable system prompt from `selectSystemPrompt(modelId)` plus optional persona, custom instructions, `TERAX.md` project memory (only while the user allows its current content, see Project memory) and the "Available skills" block (see Skills). The system prompt goes with every step whole, so a run whose system prompt alone does not fit the model's context (four characters a token, `compact.ts`) fails at once with a message saying so, naming `TERAX.md` and its size when that is what does not fit, instead of a provider error.
3. Converts UI messages to model messages, prunes reasoning content if the model does not keep it, and compacts old messages when the system prompt and the history together near the context limit (the system prompt counts against it first, so a long conversation in a project with a large `TERAX.md` compacts earlier).
4. Streams via `streamText` with the tool set from `buildTools(ctx)`, the run's approval policy (`buildToolApproval`, see below), the chosen reasoning effort (`reasoningCallOptions`) and `stopWhen: isStepCount(MAX_AGENT_STEPS)`.
5. Emits step labels, usage deltas, and finish metadata.

The tool set is assembled in `src/modules/ai/tools/tools.ts` from the `fs`, `edit`, `search`, `shell`, `subagent`, `terminal`, `todo`, managed-agent (`agent.ts`) and `skills` builders, plus the window's MCP tools (below).

`createContextAwareTransport` (`src/modules/ai/lib/transport.ts`) is the chat transport: it adds the environment block (`<env>`) to the last user message, each path as it is or, when it could start a line or end the block, as a JSON string (`pathText`), asks the backend for `TERAX.md` (see Project memory), runs `runAgentStream` and returns `toUIMessageStream(...)` for the `Chat`.

### Project memory

A project's `TERAX.md` (at the workspace root) is an item of the shared project trust (`ItemKind::TeraxMd`, `src-tauri/src/modules/project_memory.rs`), asked about in the same prompt as the project's skills and `.mcp.json`. The prompt shows its size, line count and first lines as plain text (control, bidirectional and zero-width characters removed), read in chunks, so a file of any size is hashed and previewed without being held; a file that is not UTF-8 text, holds a NUL byte or links out of the project is listed as not usable, and an empty one asks nothing. There is no size limit: the model gets the whole allowed file, and the prompt's size tells the user what they allow. On every run `transport.ts` calls `project_memory_read` with the run's workspace root and the most the run's model could take (`maxMemoryBytes`: its context at four characters a token and four bytes a character): the backend answers only for the calling window's open project (the root must be that project), only inside the folders the AI's file tools reach, and returns the text only when the user's decision allows the SHA-256 of exactly the bytes it read. A larger allowed file comes back as its size alone, and the run fails saying the file does not fit, without reading it into memory. Not allowed, declined, changed since, missing or refused: the run goes on with no project memory. Nothing is cached in the page, so allowing, revoking or a change takes effect on the next run.

Terax's own writes keep the answer, for `TERAX.md` as for the project's skills and `.mcp.json` (`project_trust::keeping_trust`): `fs_write_file` (the editor's save, the AI's `write_file`, `edit` and `multi_edit` once approved or under Auto-approve, plan mode's Apply, `/init`'s write) and the creates of `fs_create_file` and `fs_create_dir` (New File, New Folder, `create_directory`) allow the item as they leave it when the user allowed what it held, or it held nothing. That is decided in the backend from the item's bytes and the bytes written, under the trust store's lock, so a decision withdrawn meanwhile holds and nothing another program wrote is taken in. Any other change (git, another editor, a shell command, an MCP server, a coding agent, the explorer's rename, move, copy, paste or delete) asks again.

### Reasoning effort

`lib/reasoningEffort.ts` decides which models offer an effort from the catalog metadata: a model tagged `reasoning` on OpenAI, Anthropic, Google or xAI (but Grok 4.20, which the AI SDK refuses an effort for) offers off, low, medium and high; DeepSeek V4 offers off and high (its `thinking` switch, with `reasoning_effort` high when on). Everything else, including endpoints, local servers and OpenRouter, hides the composer's picker. The choice is remembered per model in `reasoningEffortByModel`; until one is made nothing is sent. For the native providers the effort becomes the AI SDK's `reasoning` call option, which each provider maps under its own constraints (Anthropic adaptive thinking with an effort or a budget within the max tokens, temperature dropped; OpenAI `reasoningEffort`; Google `thinkingConfig`; xAI `reasoningEffort`); "off" gives a model that always thinks its lowest setting. `reasoningEffort.test.ts` checks the request body each provider builds.

## Skills

Skills follow the Agent Skills format (as Claude Code and Codex use it): a folder with a `SKILL.md`, YAML frontmatter (`name`, `description`) and Markdown instructions, plus optional reference files and scripts. The backend (`src-tauri/src/modules/skills/`) discovers them in Terax's skills folder (the app config folder's `skills/`), `~/.claude/skills`, and the `.claude/skills` and `.terax/skills` of the project a conversation works in once the user trusts them (`project_trust.rs`, see the security model). A change to a project's skills asks again, except one Terax makes itself (a `SKILL.md` saved from Settings' Edit, the AI's approved writes, New File or New Folder inside the folder), which keeps the answer (see Project memory). A name found in several places is taken from the project (`.terax/skills` over `.claude/skills`), else `~/.claude/skills`, else Terax's folder; a skill turned off takes no part.

- **Validation** (`skills/frontmatter.rs`, a small YAML reader for frontmatter: plain, quoted and block scalars, lists and maps). `name` follows the specification (1 to 64 lowercase letters, digits and hyphens, no hyphen at either end or twice in a row); without one the folder name is used, and a name that differs from its folder is a warning. `description` may have at most 1,024 characters; without one, the first line of the instructions is used, as Claude Code does. `compatibility` may have 500. A field that does not parse fails only when Terax uses it; other tools' fields (`metadata`, `hooks`, `allowed-tools`, ...) are skipped. `disable-model-invocation: true` keeps a skill out of the model's list (only `/name` calls it) and `user-invocable: false` out of the slash list. Invalid skills are listed in Settings with every reason. Folders named `.something` or `synced` (Claude Code's own) are skipped.
- **The model's view.** Each run lists the skills the conversation may use (`loadAgentSkills`, through `skills_list` for the workspace root). `skillsPromptBlock` (`src/modules/skills/prompt.ts`) adds an "Available skills" section to the system prompt: name and description (with `when_to_use`, 1,536 characters at most each) of every skill the model may load, within 8,000 characters; names always fit first and the longest descriptions are shortened first. `use_skill` returns a skill's instructions (`${CLAUDE_SKILL_DIR}` filled in, 60,000 characters at most), its folder (as a WSL shell reaches it in a WSL conversation) and its file list; `read_skill_file` reads one of its text files by relative path (25 KB windows like `read_file`). Both are `TOOL_GATES` `none`. A run with no skill offers neither tool (`activeTools`). Scripts run through `bash_run`/`bash_background` with their absolute path, under the usual approval. Sub-agents get no skill tools.
- **`/skill-name`.** The composer's `/` list shows the skills the user may call (`useUserSkills`). Sending `/name text` (typed, or the skill picked as a chip) loads the skill and sends its instructions in a `<skill name="..." dir="...">` block before the text; `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` take the user's arguments (Claude Code's substitutions; `\$` keeps a dollar sign). A built-in command of the same name wins. The conversation shows the block as a chip.
- **Settings > Skills** lists the skills by source (Terax, `~/.claude/skills`, each open project with its trust state) with on/off switches, notes and validation errors; creates a skill from a template and opens it in the editor; edits any skill's `SKILL.md`; deletes skills of Terax's folder (to the trash); installs from a Git address (a GitHub `/tree/<branch>/<folder>` address picks a folder) or a zip, reviewing what was found before anything is kept. On/off state is kept by the backend (`skills-state.json`), so a skill turned off can be neither listed nor loaded. A watcher (`skills/watch.rs`: FSEvents on macOS, notify elsewhere; a missing folder through its parent) tells every window when skills or trust change (`skills:changed`), only when the listing really changed.

## Sub-agents

`src/modules/ai/agents/registry.ts` defines read-only sub-agents: `explore`, `code-review`, `security`, and `general`. Each has a whitelist of tools and its own system prompt. `run_subagent` cannot recurse (the subagent tool set excludes `run_subagent` itself). A sub-agent runs on the window's selected model; `runSubagent` reports each step's usage with that model's id (`onUsage`), and `run_subagent` counts it in the meter of the conversation that started it (`countConversationUsage`, so only while that conversation is the open one), as the agent's own steps are.

## Sessions

Conversations are organized into sessions (`src/modules/ai/lib/sessions.ts`):

- `terax-ai-sessions.json` (`tauri-plugin-store`) holds only session metadata and the active id.
- Message arrays live in per-session `conversations/session-<id>.json` files owned by Rust (`src-tauri/src/modules/ai_sessions.rs`, commands `ai_session_load` / `ai_session_save` / `ai_session_delete`). Writes are atomic, keep a `.bak` of the previous version, and set a damaged file aside as `.corrupt`.
- Conversations from older versions, stored under `messages:<id>` keys of the metadata store, are migrated per session (`ai_session_finish_migration`, `ai_session_prune_backup`).

`TERAX.md` documents the durability rules (flush cadence, fsync, close-time flush).

`AgentRunBridge` mirrors active-session messages to disk on every change and auto-derives titles from the first user message (`deriveTitle`): the user's own words without the blocks before them, a `/command`'s quoted request or label, or `/skill` and `server: prompt` for a message that only invokes one.

## Composer

`AiComposerProvider` (`src/modules/ai/lib/composer.tsx`) is a React context that holds shared input state (text, attachments, voice) for the docked input bar and any other surface. Attachments can be images, text files, or `selection` chips from the terminal or editor. Images come from the picker or a paste (`lib/pastedImages.ts`; where the webview hands a clipboard image over as no file, WebKitGTK, the app reads it with `clipboard_image_read`). An image is sent as it is when every provider takes it (PNG, JPEG, GIF or WebP within Anthropic's 5 MiB of base64), else decoded and encoded again within 2048 px (`lib/imageAttachment.ts`), and the conversation shows the images a message carried. Selections are wrapped as `<selection source="terminal|editor">…</selection>` blocks at submit time and are not pasted into the textarea.

A file reaches the composer by path through Attach to Agent, an `@` mention or a drop from the explorer (`lib/pathAttachment.ts`), and a text attachment holds up to 200 KB however it is added. A picked file is read as when the user opens it (its folder is authorized). A dropped file is read as the agent's `read_file` reads it, through the secret-path deny-list and the backend's gates with `origin: "ai"`, and nothing is authorized, so a drop never gives the AI a file it could not read itself. A dropped folder is named in the prompt as inline code (`lib/composerDrop.ts`), never listed or read into it; the agent's own tools then reach it, or not, under the same limits.

The composer derives `isBusy` from `agentMeta.status` so it can mount safely before sessions hydrate.

## Tools and approval

Tool definitions live under `src/modules/ai/tools/`:

- `TOOL_GATES` in `tools.ts` classifies every tool as `none`, `approvable` (file changes), `approvable-outside-plan` (shell commands) or `always` (the coding-agent tools). The record is exhaustive, so a new tool does not compile until it is classified. `runAgentStream` turns it into each run's `toolApproval` with `buildToolApproval`, whose gated entries read the conversation's approval mode and plan mode on every call; sub-agents get Ask mode's fixed `TOOL_APPROVAL`.
- Each conversation is in **Ask** (the default) or **Auto-approve** (`SessionMeta.approvalMode`, chosen in the composer; new conversations start in the Settings default `aiApprovalMode`). Auto-approve runs `approvable` tools, and `approvable-outside-plan` ones outside plan mode, without a card; their `execute` still applies the deny-lists. `always` tools ask in every mode. While it is on, the composer shows a chip that turns it off in one click, and the mini window and the running status pill show it too.
- Read-only tools (`read_file`, `list_directory`, `grep`, `glob`) auto-execute after passing the security deny-list. Like every file tool, they are refused outside the folders the workspace registry authorizes; a path named by the model or a tool result never authorizes anything.
- In Ask mode, mutating tools (`write_file`, `edit`, `multi_edit`, `create_directory`, `bash_run`, `bash_background`) and the coding-agent tools (`spawn_coding_agent`, `send_to_agent`) are `user-approval`. The AI SDK pauses and the UI renders an approval card.
- Other tools run without an approval card: `bash_logs`, `bash_list`, `bash_kill` (background processes the agent started), `get_terminal_output` (refused for private terminals), `suggest_command` (renders an Insert card, never writes to a terminal), `open_preview`, `todo_write`, `read_agent_output`, `run_subagent`, and `use_skill` and `read_skill_file` (confined to the conversation's usable skills, see Skills).
- `edit` / `multi_edit` enforce a read-before-edit invariant: the model must have read the file earlier in the session.
- In plan mode, mutating tools queue edits for batch review instead of applying them immediately. Apply (`planStore.applyAll`) writes the edits queued when it was pressed, re-checks each path against the deny-list (canonicalized) at write time, skips edits rejected meanwhile, and leaves edits queued during the writes for the next review.

Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`.

### MCP tools

Tools of MCP servers come from the window's MCP client (`src/modules/mcp/`). The window's servers are the ones configured in Settings (added there or imported from Claude Desktop, Claude Code, Cursor or VS Code, which start off) and those of its project's `.mcp.json` while the user allows that file (`loadWindowServers`; on unless turned off, never trusted until the user says so). On every run `transport.ts` calls `mcpToolsForRun`: with no server enabled it only reads the configuration; otherwise it loads the client chunk, brings the window's servers in line (starting them on the first run, which waits up to 15 s for servers still starting) and returns their tools. A remote server that needs sign-in (OAuth, run by the backend in Settings) contributes no tools until the user signs in; its tokens never reach the page or the model. `runAgentStream` adds them beside the built-in tools:

- Names are `mcp__<server>__<tool>` (sanitized, at most 64 characters), each a `dynamicTool` with the server's input schema, a capped description and `metadata.mcp` (server and tool), which UI parts carry as `toolMetadata`.
- Gates (`mcpToolGate`, `mcpToolsWithGates` in `tools.ts`): an untrusted server's tools ask in every mode; a Trusted server's follow the conversation's mode (plan mode asks); Always allow runs a tool unasked; Never allow keeps it from the model. Annotations are shown, never used. Sub-agents get no MCP tools.
- Execution goes to the server through the window's client (`runtime/manager.ts`): two minutes without progress, fifteen at most, cancelled with the run. Results are capped and kept as text and images (`lib/results.ts`); `toModelOutput` hands them to the model as text and files, and history is converted with a converter for MCP calls whose tool is gone (`lib/mcpHistory.ts`).
- The system prompt gains an MCP block saying results are untrusted data, with each server's instructions.
- The chat renders MCP calls with `components/McpTool.tsx`: the approval card names the server and shows the arguments and the server's annotations; the transcript row marks the result as external.

### MCP resources, prompts, sampling and elicitation

The rest of what MCP servers offer reaches the chat through the composer and the window's request host, never through the agent's tools:

- **Resources**: the composer's `@` picker lists each running server's resources and templates after the workspace files (opening it starts the window's enabled servers). A resource is read and attached like a file (same caps), a template first asks for its variables in a small form with the server's completions. It is sent in an `<mcp-resource>` block naming the server and marking the content as its data.
- **Prompts**: `/<server>:<prompt>` in the `/` list. Its arguments are asked for in the same form (required ones enforced, completions if offered), then its messages are sent in an `<mcp-prompt>` block, which says they are the server's words and not the user's instructions, before the user's own text. Lists refresh on the server's `list_changed` notifications.
- **Sampling**: an approval dialog in the window whose server asked, editable, with `includeContext` treated as none and said so. Approve runs only that request on the conversation's model (or a configured model matching the server's hints, or one the user picks), no tools, at most its max tokens and never more than 8,192; the reply needs a second approval before it goes back. Deny returns the spec's rejection.
- **Elicitation**: a form in the chat built from the requested schema's primitive fields, validated, with Submit, Decline and Dismiss for accept, decline and cancel. Unsupported schemas and URL mode are refused with the reason.

None of these is answered without the user, whatever the approval mode or the server's trust, and each request ends when the server cancels it or stops. See `TERAX.md` (AI subsystem) for the modules.

A tool call needs a result before any later request: one without it fails every following prompt with `MissingToolResultsError`. So only the newest message's approvals can be answered (`pendingApprovalIds` in `lib/toolApprovals.ts`): older cards render as denied rows, their diff tabs close, and the diff-tab responder ignores them. Every user message (composer, Continue, managed-agent review) goes through `sendUserMessage` in `store/chatRuntime.ts`, which first replaces the messages holding unanswered approvals (waiting, or approved but never run) with copies where those calls are denied, so the model is told they did not run and the settled state is what gets persisted.

In plan mode, an edit that Apply could not write (a write error, or a path the deny-list refuses at write time) stays in the review list with its error until it is applied or rejected; written edits leave the list.

## Edit diffs

AI-proposed file edits open in an `ai-diff` tab. The user accepts or rejects per hunk. Only after acceptance does the `write_file` or `edit` tool actually run. This keeps the approval UI decoupled from the tool execution.

## Live context bridge

`App.tsx` calls `setLive({ getCwd, getTerminalContext, … })` so tools can read the currently active terminal's cwd and the last 300 lines of buffer. It is lazy by design - tools call for it only when needed rather than pre-snapshotting every turn.

## Invariants

- Keep the Vercel AI SDK v7 chat shape (`streamText`, tools, `toolApproval`, step limits); the rest of the UI depends on it.
- Keys only via `secrets_*` commands; never disk, settings store, or `localStorage`.
- New providers must justify their bundle cost and unique value.
- Mutating tools require approval unless the conversation is in Auto-approve; the coding-agent tools always do, and no mode skips a deny-list. Read-only tools still pass the deny-list.
- MCP tools of an untrusted server ask in every mode; an MCP tool is never offered without its gate, and server annotations never relax one. Imported and project servers are untrusted until the user says otherwise; a project's servers run only while the user allows its `.mcp.json`.
- A server's sampling and elicitation requests wait for the user in every mode; MCP resources and prompts reach the model only in their server-labelled blocks.
- A project's skills reach the model only while the user trusts that content; a skill's text never changes approval.
- A project's `TERAX.md` reaches the model only through `project_memory_read`, only while the user allows exactly the content read; only Terax's own `fs_write_file`, `fs_create_file` and `fs_create_dir` carry an allowed answer over to a project item's new content.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [Security model](security-model.md) - the boundaries every tool must respect
