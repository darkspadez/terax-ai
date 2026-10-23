/**
 * An MCP tool result as the agent sees it. Everything a server returns is
 * untrusted input: text is capped (with a note to the model when cut), images
 * are kept within size limits, other content becomes a short note. Pure.
 */

export const MAX_RESULT_TEXT = 50_000;
export const MAX_RESULT_IMAGES = 4;
/** Per image, as base64; what every provider takes. */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;
const MAX_IMAGES_BASE64_TOTAL = 8 * 1024 * 1024;
const MAX_ERROR_TEXT = 4000;
/** Image types every provider takes. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type McpOutputPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string };

/** What an MCP tool call stores as its output in the conversation. */
export type McpToolOutput = {
  kind: "mcp";
  server: string;
  tool: string;
  content: McpOutputPart[];
  /** Notes on what was cut or left out, also given to the model. */
  notes: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

type Draft = {
  parts: McpOutputPart[];
  notes: string[];
  textUsed: number;
  textTotal: number;
  imagesUsed: number;
  imageBytes: number;
};

function addText(draft: Draft, text: string): void {
  draft.textTotal += text.length;
  const room = MAX_RESULT_TEXT - draft.textUsed;
  if (room <= 0) return;
  const kept = text.length > room ? text.slice(0, room) : text;
  draft.textUsed += kept.length;
  const last = draft.parts[draft.parts.length - 1];
  if (last?.type === "text") last.text += `\n${kept}`;
  else draft.parts.push({ type: "text", text: kept });
}

function addImage(draft: Draft, mediaType: string, data: string): void {
  const type = mediaType.toLowerCase();
  if (!IMAGE_TYPES.has(type)) {
    draft.notes.push(`An image of type ${type} was left out.`);
    return;
  }
  if (
    draft.imagesUsed >= MAX_RESULT_IMAGES ||
    data.length > MAX_IMAGE_BASE64 ||
    draft.imageBytes + data.length > MAX_IMAGES_BASE64_TOTAL
  ) {
    draft.notes.push("An image was left out: over the size limit.");
    return;
  }
  draft.imagesUsed += 1;
  draft.imageBytes += data.length;
  draft.parts.push({ type: "image", mediaType: type, data });
}

function addResource(draft: Draft, resource: Record<string, unknown>): void {
  const uri = str(resource.uri) ?? "(no uri)";
  const mime = str(resource.mimeType);
  const text = str(resource.text);
  const blob = str(resource.blob);
  if (text !== null) {
    addText(draft, `Resource ${uri}:\n${text}`);
  } else if (blob !== null && mime && IMAGE_TYPES.has(mime.toLowerCase())) {
    addImage(draft, mime, blob);
  } else {
    draft.notes.push(
      `A binary resource was left out: ${uri}${mime ? ` (${mime})` : ""}.`,
    );
  }
}

/** The text of an error result, or of a protocol error, for the tool error. */
export function errorText(result: unknown, fallback: string): string {
  const parts =
    isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((p) => (isRecord(p) && p.type === "text" ? str(p.text) : null))
    .filter((t): t is string => t !== null)
    .join("\n")
    .trim();
  const message = text || fallback;
  return message.length > MAX_ERROR_TEXT
    ? `${message.slice(0, MAX_ERROR_TEXT)}…`
    : message;
}

/**
 * A `tools/call` result as stored output, or an error when the server
 * reported one (`isError`), which becomes the tool's error.
 */
export function toToolOutput(
  result: unknown,
  server: string,
  tool: string,
): { output: McpToolOutput } | { error: string } {
  if (!isRecord(result)) return { error: "The server returned no result." };
  if (result.isError === true) {
    return { error: errorText(result, "The tool reported an error.") };
  }
  const draft: Draft = {
    parts: [],
    notes: [],
    textUsed: 0,
    textTotal: 0,
    imagesUsed: 0,
    imageBytes: 0,
  };
  const content = Array.isArray(result.content) ? result.content : [];
  let hasText = false;
  for (const item of content) {
    if (!isRecord(item)) continue;
    switch (item.type) {
      case "text": {
        const text = str(item.text);
        if (text !== null) {
          hasText = true;
          addText(draft, text);
        }
        break;
      }
      case "image": {
        const data = str(item.data);
        const mime = str(item.mimeType);
        if (data && mime) addImage(draft, mime, data);
        break;
      }
      case "audio":
        draft.notes.push("Audio content was left out.");
        break;
      case "resource_link": {
        const uri = str(item.uri) ?? "";
        const name = str(item.name) ?? uri;
        const mime = str(item.mimeType);
        addText(
          draft,
          `Resource link: ${name} <${uri}>${mime ? ` (${mime})` : ""}`,
        );
        break;
      }
      case "resource":
        if (isRecord(item.resource)) addResource(draft, item.resource);
        break;
      default:
        draft.notes.push(`Content of type ${String(item.type)} was left out.`);
    }
  }
  if (!hasText && result.structuredContent !== undefined) {
    let json = "";
    try {
      json = JSON.stringify(result.structuredContent, null, 2) ?? "";
    } catch {
      json = "";
    }
    if (json) addText(draft, json);
  }
  if (draft.textTotal > draft.textUsed) {
    draft.notes.push(
      `Output truncated: the server returned ${draft.textTotal.toLocaleString("en-US")} characters of text; the first ${draft.textUsed.toLocaleString("en-US")} are shown.`,
    );
  }
  if (draft.parts.length === 0 && draft.notes.length === 0) {
    draft.parts.push({ type: "text", text: "(no output)" });
  }
  return {
    output: {
      kind: "mcp",
      server,
      tool,
      content: draft.parts,
      notes: draft.notes,
    },
  };
}

export function isMcpToolOutput(value: unknown): value is McpToolOutput {
  return (
    isRecord(value) &&
    value.kind === "mcp" &&
    Array.isArray(value.content) &&
    Array.isArray(value.notes)
  );
}

/** The model's view of an output (`toModelOutput`): text and images. */
export type McpModelOutput =
  | { type: "text"; value: string }
  | {
      type: "content";
      value: Array<
        | { type: "text"; text: string }
        | {
            type: "file";
            mediaType: string;
            data: { type: "data"; data: string };
          }
      >;
    };

export function mcpToModelOutput(output: unknown): McpModelOutput {
  if (!isMcpToolOutput(output)) {
    return { type: "text", value: JSON.stringify(output ?? null) };
  }
  const value: Extract<McpModelOutput, { type: "content" }>["value"] = [];
  for (const part of output.content) {
    if (part.type === "text") value.push({ type: "text", text: part.text });
    else
      value.push({
        type: "file",
        mediaType: part.mediaType,
        data: { type: "data", data: part.data },
      });
  }
  if (output.notes.length > 0) {
    value.push({ type: "text", text: `[${output.notes.join(" ")}]` });
  }
  if (value.every((part) => part.type === "text")) {
    return {
      type: "text",
      value: value
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n"),
    };
  }
  return { type: "content", value };
}
