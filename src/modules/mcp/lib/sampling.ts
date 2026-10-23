import type { ModelMessage } from "ai";
import type { TokenUsage } from "@/modules/ai/lib/usage";
import { IMAGE_TYPES, MAX_IMAGE_BASE64, MAX_RESULT_IMAGES } from "./results";

/**
 * A server's sampling request (`sampling/createMessage`) as the approval
 * dialog shows and edits it, what the model is given once the user
 * approves, and what goes back to the server once the user approves the
 * result. Terax offers no tools to sampling and includes no context of its
 * own (`includeContext` is shown, never honoured). Pure.
 */

/** The most tokens a sampling request may generate, whatever it asks for. */
export const SAMPLING_MAX_TOKENS = 8192;
const MAX_MESSAGES = 100;
/** Text across the messages and the system prompt, in UTF-16 units. */
export const MAX_SAMPLING_TEXT = 200_000;

type SamplingImage = { mediaType: string; data: string };

export type SamplingMessageDraft = {
  role: "user" | "assistant";
  text: string;
  images: SamplingImage[];
};

type IncludeContext = "none" | "thisServer" | "allServers";

export type SamplingRequestView = {
  messages: SamplingMessageDraft[];
  systemPrompt: string;
  /** As the server asked; the dialog starts from it, capped. */
  maxTokens: number;
  temperature: number | null;
  stopSequences: string[];
  includeContext: IncludeContext;
  hints: string[];
  priorities: {
    cost: number | null;
    speed: number | null;
    intelligence: number | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function priority(value: unknown): number | null {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : null;
}

/** The request as the dialog shows it, or why Terax refuses it outright. */
export function samplingRequestView(
  params: unknown,
): { view: SamplingRequestView } | { refused: string } {
  if (!isRecord(params)) return { refused: "The request has no parameters." };
  if (params.tools !== undefined || params.toolChoice !== undefined) {
    return { refused: "Terax does not offer tools to sampling requests." };
  }
  if (params.task !== undefined) {
    return { refused: "Terax does not run sampling requests as tasks." };
  }
  const rawMessages = Array.isArray(params.messages) ? params.messages : [];
  if (rawMessages.length === 0)
    return { refused: "The request has no messages." };
  if (rawMessages.length > MAX_MESSAGES) {
    return { refused: `The request has more than ${MAX_MESSAGES} messages.` };
  }
  const maxTokens = params.maxTokens;
  if (
    typeof maxTokens !== "number" ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1
  ) {
    return {
      refused: "The request's maxTokens is not a positive whole number.",
    };
  }
  const messages: SamplingMessageDraft[] = [];
  let images = 0;
  let imageBytes = 0;
  for (const raw of rawMessages) {
    if (!isRecord(raw)) return { refused: "A message is malformed." };
    const role = raw.role === "assistant" ? "assistant" : "user";
    const parts = Array.isArray(raw.content) ? raw.content : [raw.content];
    const texts: string[] = [];
    const messageImages: SamplingImage[] = [];
    for (const part of parts) {
      if (!isRecord(part)) return { refused: "A message is malformed." };
      if (part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      } else if (part.type === "image") {
        const mime =
          typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
        const data = typeof part.data === "string" ? part.data : "";
        if (role === "assistant") {
          return {
            refused: "Terax cannot send images as the model's own words.",
          };
        }
        if (!IMAGE_TYPES.has(mime)) {
          return {
            refused: `Terax cannot send an image of type ${mime || "unknown"}.`,
          };
        }
        images += 1;
        imageBytes += data.length;
        if (
          !data ||
          images > MAX_RESULT_IMAGES ||
          data.length > MAX_IMAGE_BASE64 ||
          imageBytes > 2 * MAX_IMAGE_BASE64
        ) {
          return { refused: "The request's images are over the size limit." };
        }
        messageImages.push({ mediaType: mime, data });
      } else if (part.type === "audio") {
        return { refused: "Terax cannot send audio to its models." };
      } else {
        return {
          refused: `Terax cannot send content of type ${String(part.type)}.`,
        };
      }
    }
    messages.push({ role, text: texts.join("\n"), images: messageImages });
  }
  const systemPrompt =
    typeof params.systemPrompt === "string" ? params.systemPrompt : "";
  const textLength =
    systemPrompt.length + messages.reduce((n, m) => n + m.text.length, 0);
  if (textLength > MAX_SAMPLING_TEXT) {
    return { refused: "The request's text is over the size limit." };
  }
  const prefs = isRecord(params.modelPreferences)
    ? params.modelPreferences
    : {};
  const hints = Array.isArray(prefs.hints)
    ? prefs.hints
        .map((h) =>
          isRecord(h) && typeof h.name === "string" ? h.name.trim() : "",
        )
        .filter((name) => name.length > 0 && name.length <= 200)
        .slice(0, 10)
    : [];
  const include = params.includeContext;
  return {
    view: {
      messages,
      systemPrompt,
      maxTokens,
      temperature:
        typeof params.temperature === "number" &&
        Number.isFinite(params.temperature)
          ? params.temperature
          : null,
      stopSequences: Array.isArray(params.stopSequences)
        ? params.stopSequences
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .slice(0, 4)
        : [],
      includeContext:
        include === "thisServer" || include === "allServers" ? include : "none",
      hints,
      priorities: {
        cost: priority(prefs.costPriority),
        speed: priority(prefs.speedPriority),
        intelligence: priority(prefs.intelligencePriority),
      },
    },
  };
}

/** What the user approves: the request as edited in the dialog. */
export type SamplingDraft = {
  messages: SamplingMessageDraft[];
  systemPrompt: string;
  maxTokens: number;
};

export function initialDraft(view: SamplingRequestView): SamplingDraft {
  return {
    messages: view.messages.map((m) => ({ ...m, images: [...m.images] })),
    systemPrompt: view.systemPrompt,
    maxTokens: Math.min(view.maxTokens, SAMPLING_MAX_TOKENS),
  };
}

/** Why the edited request cannot run, or null. */
export function samplingDraftProblem(draft: SamplingDraft): string | null {
  if (
    !Number.isInteger(draft.maxTokens) ||
    draft.maxTokens < 1 ||
    draft.maxTokens > SAMPLING_MAX_TOKENS
  ) {
    return `Max tokens must be a whole number from 1 to ${SAMPLING_MAX_TOKENS.toLocaleString("en-US")}.`;
  }
  if (!draft.messages.some((m) => m.text.trim() || m.images.length > 0)) {
    return "There is no message left to send.";
  }
  const length =
    draft.systemPrompt.length +
    draft.messages.reduce((n, m) => n + m.text.length, 0);
  if (length > MAX_SAMPLING_TEXT) return "The request is too long.";
  return null;
}

/** The messages the model gets: empty ones dropped, images as files. */
export function samplingModelMessages(
  messages: readonly SamplingMessageDraft[],
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    const text = m.text.trim();
    if (m.role === "assistant") {
      if (text) out.push({ role: "assistant", content: m.text });
      continue;
    }
    if (!text && m.images.length === 0) continue;
    out.push({
      role: "user",
      content: [
        ...(text ? [{ type: "text" as const, text: m.text }] : []),
        ...m.images.map((image) => ({
          type: "file" as const,
          mediaType: image.mediaType,
          data: { type: "data" as const, data: image.data },
        })),
      ],
    });
  }
  return out;
}

export type ModelChoice = { id: string; label: string };

/**
 * The model a request runs with: the first of its hints (in order) that the
 * conversation's model matches, else that some other usable model matches
 * (by id or name, case-insensitively), else the conversation's model.
 */
export function chooseSamplingModel(
  hints: readonly string[],
  current: ModelChoice,
  usable: readonly ModelChoice[],
): { model: ModelChoice; hint: string | null } {
  const matches = (model: ModelChoice, hint: string) => {
    const h = hint.toLowerCase();
    return (
      model.id.toLowerCase().includes(h) ||
      model.label.toLowerCase().includes(h)
    );
  };
  for (const hint of hints) {
    if (matches(current, hint)) return { model: current, hint };
    const other = usable.find((m) => matches(m, hint));
    if (other) return { model: other, hint };
  }
  return { model: current, hint: null };
}

/** The spec's stop reason for the AI SDK's finish reason. */
export function stopReasonFor(finishReason: string): string {
  if (finishReason === "stop") return "endTurn";
  if (finishReason === "length") return "maxTokens";
  return finishReason || "endTurn";
}

/**
 * What a run used, as the dialog's result step says it, and whether the
 * conversation's meter counted it.
 */
export function samplingUsageNote(usage: TokenUsage, counted: boolean): string {
  const total = usage.inputTokens + usage.outputTokens;
  if (total === 0) return "The model reported no token usage.";
  const n = (value: number) => value.toLocaleString("en-US");
  return `Used ${n(total)} ${total === 1 ? "token" : "tokens"} (${n(usage.inputTokens)} in, ${n(usage.outputTokens)} out)${counted ? ", counted in this conversation's usage" : ""}.`;
}

/** The `sampling/createMessage` result the user approved. */
export function samplingResult(
  text: string,
  model: string,
  finishReason: string,
): {
  role: "assistant";
  content: { type: "text"; text: string };
  model: string;
  stopReason: string;
} {
  return {
    role: "assistant",
    content: { type: "text", text },
    model,
    stopReason: stopReasonFor(finishReason),
  };
}
