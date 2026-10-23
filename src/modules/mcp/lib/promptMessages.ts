import { MAX_TEXT_ATTACHMENT_BYTES } from "@/modules/ai/lib/pathAttachment";
import { mcpPromptBlock } from "./blocks";
import { IMAGE_TYPES, MAX_IMAGE_BASE64, MAX_RESULT_IMAGES } from "./results";

/**
 * A `prompts/get` result as what the composer sends: the server's messages
 * as text in one `<mcp-prompt>` block (with their roles when there is more
 * than one or an assistant's), their images as file parts, and notes on
 * what was left out. The text is capped like a text attachment; a larger
 * prompt is refused rather than cut, since a cut prompt asks something else.
 * Pure.
 */

export type PromptImage = { mediaType: string; data: string };

export type PromptMessage =
  | { block: string; images: PromptImage[]; notes: string[] }
  | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function promptMessage(
  result: unknown,
  server: string,
  prompt: string,
): PromptMessage {
  const messages =
    isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
  const images: PromptImage[] = [];
  const notes: string[] = [];
  const sections: { role: string; lines: string[] }[] = [];
  const addImage = (mime: string | null, data: string | null) => {
    const type = mime?.toLowerCase() ?? "";
    if (!data || !IMAGE_TYPES.has(type)) {
      notes.push(`An image${type ? ` of type ${type}` : ""} was left out.`);
      return false;
    }
    if (images.length >= MAX_RESULT_IMAGES || data.length > MAX_IMAGE_BASE64) {
      notes.push("An image was left out: over the size limit.");
      return false;
    }
    images.push({ mediaType: type, data });
    return true;
  };
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = Array.isArray(message.content)
      ? message.content
      : [message.content];
    const lines: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      switch (item.type) {
        case "text": {
          const text = str(item.text);
          if (text !== null) lines.push(text);
          break;
        }
        case "image":
          if (addImage(str(item.mimeType), str(item.data))) {
            lines.push(`(Image ${images.length} is attached to this message.)`);
          }
          break;
        case "resource_link": {
          const uri = str(item.uri) ?? "";
          const name = str(item.name) ?? uri;
          lines.push(`Resource link: ${name} <${uri}>`);
          break;
        }
        case "resource": {
          const resource = isRecord(item.resource) ? item.resource : {};
          const uri = str(resource.uri) ?? "(no uri)";
          const text = str(resource.text);
          const blob = str(resource.blob);
          const mime = str(resource.mimeType)?.toLowerCase() ?? "";
          if (text !== null) {
            lines.push(`Resource ${uri}:\n${text}`);
          } else if (blob !== null && mime.startsWith("image/")) {
            if (addImage(mime, blob)) {
              lines.push(
                `Resource ${uri}: image ${images.length}, attached to this message.`,
              );
            }
          } else {
            notes.push(`The binary resource ${uri} was left out.`);
          }
          break;
        }
        case "audio":
          notes.push("Audio content was left out.");
          break;
        default:
          notes.push(`Content of type ${String(item.type)} was left out.`);
      }
    }
    if (lines.length > 0) sections.push({ role, lines });
  }
  if (sections.length === 0 && images.length === 0) {
    return {
      error: `The prompt ${prompt} returned no messages Oarlock can send.`,
    };
  }
  const labelled =
    sections.length > 1 || sections.some((s) => s.role === "assistant");
  const body = sections
    .map((s) =>
      labelled ? `[${s.role}]\n${s.lines.join("\n")}` : s.lines.join("\n"),
    )
    .join("\n\n");
  const size = new TextEncoder().encode(body).length;
  if (size > MAX_TEXT_ATTACHMENT_BYTES) {
    return {
      error: `The prompt ${prompt} is ${Math.ceil(size / 1000)} KB of text; a prompt can bring up to ${MAX_TEXT_ATTACHMENT_BYTES / 1000} KB.`,
    };
  }
  return { block: mcpPromptBlock(server, prompt, body), images, notes };
}
