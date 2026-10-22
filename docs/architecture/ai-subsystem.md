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

A selectable model id is a catalog id, a local server's placeholder (`ollama-local`, resolved to its configured model id) or a custom endpoint's `compat-<endpointId>`. Every surface builds it with `buildConfiguredLanguageModel`: the chat from its transport getters, everything else (sub-agents, commit messages) with `liveModelConfig()` (`store/modelConfig.ts`), which carries the endpoints and their keys, so no caller can leave out what a custom endpoint needs. `modelConfigProblem` (`lib/modelTarget.ts`, free of the AI SDK) makes the same checks without building, to gate an action. Persisted ids (default model, favorites, recents) survive a restart when `isResolvableModelId` accepts them: a catalog id, or an endpoint that still exists and is complete. The legacy single endpoint is migrated under the fixed id `legacy`, and an empty saved endpoint list is never migrated again. In Settings, the Model ID of a custom endpoint or local server can be picked from the server's `GET <base>/models` list (Browse, `lib/endpointModels.ts`, through the native proxy with the endpoint's key).

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
2. Builds a stable system prompt from `selectSystemPrompt(modelId)` plus optional persona, custom instructions, and `TERAX.md` project memory.
3. Converts UI messages to model messages, prunes reasoning content if the model does not keep it, and compacts old messages if the context limit is exceeded.
4. Streams via `streamText` with the tool set from `buildTools(ctx)`, the run's approval policy (`buildToolApproval`, see below), the chosen reasoning effort (`reasoningCallOptions`) and `stopWhen: isStepCount(MAX_AGENT_STEPS)`.
5. Emits step labels, usage deltas, and finish metadata.

The tool set is assembled in `src/modules/ai/tools/tools.ts` from the `fs`, `edit`, `search`, `shell`, `subagent`, `terminal`, `todo`, and managed-agent (`agent.ts`) builders.

`createContextAwareTransport` (`src/modules/ai/lib/transport.ts`) is the chat transport: it adds the environment block to the last user message, reads `TERAX.md` (capped, cached per workspace root), runs `runAgentStream` and returns `toUIMessageStream(...)` for the `Chat`.

### Reasoning effort

`lib/reasoningEffort.ts` decides which models offer an effort from the catalog metadata: a model tagged `reasoning` on OpenAI, Anthropic, Google or xAI (but Grok 4.20, which the AI SDK refuses an effort for) offers off, low, medium and high; DeepSeek V4 offers off and high (its `thinking` switch, with `reasoning_effort` high when on). Everything else, including endpoints, local servers and OpenRouter, hides the composer's picker. The choice is remembered per model in `reasoningEffortByModel`; until one is made nothing is sent. For the native providers the effort becomes the AI SDK's `reasoning` call option, which each provider maps under its own constraints (Anthropic adaptive thinking with an effort or a budget within the max tokens, temperature dropped; OpenAI `reasoningEffort`; Google `thinkingConfig`; xAI `reasoningEffort`); "off" gives a model that always thinks its lowest setting. `reasoningEffort.test.ts` checks the request body each provider builds.

## Sub-agents

`src/modules/ai/agents/registry.ts` defines read-only sub-agents: `explore`, `code-review`, `security`, and `general`. Each has a whitelist of tools and its own system prompt. `run_subagent` cannot recurse (the subagent tool set excludes `run_subagent` itself).

## Sessions

Conversations are organized into sessions (`src/modules/ai/lib/sessions.ts`):

- `terax-ai-sessions.json` (`tauri-plugin-store`) holds only session metadata and the active id.
- Message arrays live in per-session `conversations/session-<id>.json` files owned by Rust (`src-tauri/src/modules/ai_sessions.rs`, commands `ai_session_load` / `ai_session_save` / `ai_session_delete`). Writes are atomic, keep a `.bak` of the previous version, and set a damaged file aside as `.corrupt`.
- Conversations from older versions, stored under `messages:<id>` keys of the metadata store, are migrated per session (`ai_session_finish_migration`, `ai_session_prune_backup`).

`TERAX.md` documents the durability rules (flush cadence, fsync, close-time flush).

`AgentRunBridge` mirrors active-session messages to disk on every change and auto-derives titles from the first user message.

## Composer

`AiComposerProvider` (`src/modules/ai/lib/composer.tsx`) is a React context that holds shared input state (text, attachments, voice) for the docked input bar and any other surface. Attachments can be images, text files, or `selection` chips from the terminal or editor. Selections are wrapped as `<selection source="terminal|editor">…</selection>` blocks at submit time and are not pasted into the textarea.

The composer derives `isBusy` from `agentMeta.status` so it can mount safely before sessions hydrate.

## Tools and approval

Tool definitions live under `src/modules/ai/tools/`:

- `TOOL_GATES` in `tools.ts` classifies every tool as `none`, `approvable` (file changes), `approvable-outside-plan` (shell commands) or `always` (the coding-agent tools). The record is exhaustive, so a new tool does not compile until it is classified. `runAgentStream` turns it into each run's `toolApproval` with `buildToolApproval`, whose gated entries read the conversation's approval mode and plan mode on every call; sub-agents get Ask mode's fixed `TOOL_APPROVAL`.
- Each conversation is in **Ask** (the default) or **Auto-approve** (`SessionMeta.approvalMode`, chosen in the composer; new conversations start in the Settings default `aiApprovalMode`). Auto-approve runs `approvable` tools, and `approvable-outside-plan` ones outside plan mode, without a card; their `execute` still applies the deny-lists. `always` tools ask in every mode. While it is on, the composer shows a chip that turns it off in one click, and the mini window and the running status pill show it too.
- Read-only tools (`read_file`, `list_directory`, `grep`, `glob`) auto-execute after passing the security deny-list. Like every file tool, they are refused outside the folders the workspace registry authorizes; a path named by the model or a tool result never authorizes anything.
- In Ask mode, mutating tools (`write_file`, `edit`, `multi_edit`, `create_directory`, `bash_run`, `bash_background`) and the coding-agent tools (`spawn_coding_agent`, `send_to_agent`) are `user-approval`. The AI SDK pauses and the UI renders an approval card.
- Other tools run without an approval card: `bash_logs`, `bash_list`, `bash_kill` (background processes the agent started), `get_terminal_output` (refused for private terminals), `suggest_command` (renders an Insert card, never writes to a terminal), `open_preview`, `todo_write`, `read_agent_output` and `run_subagent`.
- `edit` / `multi_edit` enforce a read-before-edit invariant: the model must have read the file earlier in the session.
- In plan mode, mutating tools queue edits for batch review instead of applying them immediately. Apply (`planStore.applyAll`) writes the edits queued when it was pressed, re-checks each path against the deny-list (canonicalized) at write time, skips edits rejected meanwhile, and leaves edits queued during the writes for the next review.

Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`.

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

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [Security model](security-model.md) - the boundaries every tool must respect
