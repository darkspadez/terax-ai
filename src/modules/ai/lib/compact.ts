import type { ModelMessage } from "ai";

const KEEP_TAIL = 24;
const ELISION_TEXT = "[elided to save context — see prior tool call in history]";
/** Characters per token, the estimate compaction works with. */
const CHARS_PER_TOKEN = 4;
/** The most bytes UTF-8 spends on one character. */
const MAX_UTF8_BYTES = 4;

/** Roughly how many tokens a text costs, by the estimate compaction uses. */
export function approxTextTokens(text: string): number {
  return text.length / CHARS_PER_TOKEN;
}

/** The largest AGENTS.md, in bytes, a model with this context could take: a
 *  larger file holds more characters than the whole context at the estimate. */
export function maxMemoryBytes(contextLimit: number): number {
  return contextLimit * CHARS_PER_TOKEN * MAX_UTF8_BYTES;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tokensText(tokens: number): string {
  return `${Math.round(tokens).toLocaleString("en-US")} tokens`;
}

/** Why a run cannot start when the project's AGENTS.md (`size` bytes) alone
 *  takes the model's whole context. */
export function memoryOverflow(size: number, contextLimit: number): string {
  return `This project's AGENTS.md (${sizeText(size)}) does not fit in the model's context of ${tokensText(contextLimit)}. Shorten it, stop using it in Settings > Skills, or choose a model with a larger context.`;
}

/**
 * Why a run cannot start because its system prompt (`systemTokens`, sent whole
 * with every step, so no compaction can help) takes the model's whole context,
 * or null when it fits. `memory` is the project's AGENTS.md in it: it is named
 * when the prompt fits without it.
 */
export function systemPromptOverflow(
  systemTokens: number,
  contextLimit: number,
  memory: { size: number; tokens: number } | null,
): string | null {
  if (systemTokens < contextLimit) return null;
  if (memory && systemTokens - memory.tokens < contextLimit) {
    return memoryOverflow(memory.size, contextLimit);
  }
  return `The instructions for this run (about ${tokensText(systemTokens)}, with your custom instructions, the project's AGENTS.md, skills and MCP servers) do not fit in the model's context of ${tokensText(contextLimit)}.`;
}

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  [k: string]: unknown;
};

function approxBytes(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") n += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content as ToolPart[]) {
        if (part.type === "text" && typeof part.text === "string")
          n += (part.text as string).length;
        else if (part.type === "tool-result")
          n += JSON.stringify(part.output ?? "").length;
        else if (part.type === "tool-call")
          n += JSON.stringify(part.input ?? "").length;
        else n += 64;
      }
    }
  }
  return n;
}

function elideToolResult(part: ToolPart): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-result") return { changed: false, part };
  if (
    part.output &&
    typeof part.output === "object" &&
    (part.output as { __elided?: boolean }).__elided
  ) {
    return { changed: false, part };
  }
  return {
    changed: true,
    part: {
      ...part,
      output: { type: "text", value: ELISION_TEXT, __elided: true },
    },
  };
}

function pathOfInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const p = (input as { path?: unknown }).path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

function collectMutationPaths(messages: ModelMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      const name = part.toolName;
      if (
        name === "edit" ||
        name === "multi_edit" ||
        name === "write_file" ||
        name === "create_directory"
      ) {
        const p = pathOfInput(part.input);
        if (p) paths.add(p);
      }
    }
  }
  return paths;
}

function collectLastReadIdxPerPath(
  messages: ModelMessage[],
): Map<string, number> {
  const lastIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      if (part.toolName !== "read_file") continue;
      const p = pathOfInput(part.input);
      if (p) lastIdx.set(p, i);
    }
  }
  return lastIdx;
}

function dropSupersededReads(messages: ModelMessage[]): {
  out: ModelMessage[];
  touched: boolean;
} {
  const mutated = collectMutationPaths(messages);
  const lastReadIdx = collectLastReadIdxPerPath(messages);

  const callIdxToPath = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call" || part.toolName !== "read_file") continue;
      const p = pathOfInput(part.input);
      const id = part.toolCallId;
      if (p && typeof id === "string") callIdxToPath.set(id, p);
    }
  }

  let touched = false;
  const out = messages.map((m, i): ModelMessage => {
    if (!Array.isArray(m.content)) return m;
    let local = false;
    const nextContent = (m.content as ToolPart[]).map((part) => {
      if (part.type !== "tool-result") return part;
      const id = part.toolCallId;
      if (typeof id !== "string") return part;
      const path = callIdxToPath.get(id);
      if (!path) return part;
      const isStale =
        mutated.has(path) ||
        (lastReadIdx.has(path) && (lastReadIdx.get(path) as number) > i);
      if (!isStale) return part;
      const r = elideToolResult(part);
      if (r.changed) local = true;
      return r.part;
    });
    if (!local) return m;
    touched = true;
    return { ...m, content: nextContent } as ModelMessage;
  });
  return { out, touched };
}

export type CompactResult = {
  messages: ModelMessage[];
  compacted: boolean;
  droppedCount: number;
};

export function compactModelMessages(
  messages: ModelMessage[],
  contextLimit: number,
): ModelMessage[] {
  return compactModelMessagesDetailed(messages, contextLimit).messages;
}

/**
 * Elides old tool results once the history nears the model's context.
 * `fixedTokens` is what every request also carries and compaction cannot
 * shrink (the system prompt, with the project's AGENTS.md), counted against
 * the context with the history.
 */
export function compactModelMessagesDetailed(
  messages: ModelMessage[],
  contextLimit: number,
  fixedTokens = 0,
): CompactResult {
  let dropped = 0;
  let working = messages;
  const tokensOf = (list: ModelMessage[]) =>
    fixedTokens + approxBytes(list) / CHARS_PER_TOKEN;
  let approxTokens = tokensOf(working);

  if (approxTokens >= 0.55 * contextLimit) {
    const r = dropSupersededReads(working);
    if (r.touched) {
      working = r.out;
      dropped++;
      approxTokens = tokensOf(working);
    }
  }

  if (approxTokens < 0.7 * contextLimit) {
    return {
      messages: working,
      compacted: dropped > 0,
      droppedCount: dropped,
    };
  }

  const out = working.slice();
  const stopIdx = Math.max(0, out.length - KEEP_TAIL);
  for (let i = 0; i < stopIdx; i++) {
    if (out[i].role === "system") continue;
    if (!Array.isArray(out[i].content)) continue;
    let local = false;
    const next = (out[i].content as ToolPart[]).map((part) => {
      const r = elideToolResult(part);
      if (r.changed) local = true;
      return r.part;
    });
    if (local) {
      out[i] = { ...out[i], content: next } as ModelMessage;
      dropped++;
      if (tokensOf(out) < 0.6 * contextLimit) break;
    }
  }

  return {
    messages: out,
    compacted: dropped > 0,
    droppedCount: dropped,
  };
}
