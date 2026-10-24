import {
  MAX_TEXT_ATTACHMENT_BYTES,
  textTooLarge,
} from "@/modules/ai/lib/pathAttachment";
import { labelText } from "./displayText";

/**
 * An MCP resource read (`resources/read`) as composer attachments, with the
 * caps of any attachment: text up to `MAX_TEXT_ATTACHMENT_BYTES`, images
 * (sent as they are, or encoded again by the composer like a pasted image).
 * A blob that is not an image is refused with a reason. The content is the
 * server's: its block names the server and says so. Pure.
 */

/** Contents one read may attach; a server listing a whole folder is cut. */
export const MAX_RESOURCE_PARTS = 10;
/** Base64 an image may have before the composer even tries to encode it. */
export const MAX_IMAGE_SOURCE_BASE64 = 20 * 1024 * 1024;

export type ResourceDraft =
  | {
      kind: "text";
      name: string;
      uri: string;
      mediaType: string;
      text: string;
      size: number;
    }
  | {
      kind: "image";
      name: string;
      uri: string;
      mediaType: string;
      /** Base64. */
      data: string;
      size: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The last segment of a URI, for a chip; the whole URI when it has none. */
function uriTail(uri: string): string {
  const path = uri.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const tail = path.slice(path.lastIndexOf("/") + 1);
  return tail && !tail.endsWith(":") ? tail : uri;
}

export function resourceAttachments(
  result: unknown,
  request: { uri: string; name: string },
): { drafts: ResourceDraft[]; refused: string[] } {
  const contents =
    isRecord(result) && Array.isArray(result.contents) ? result.contents : [];
  const drafts: ResourceDraft[] = [];
  const refused: string[] = [];
  if (contents.length === 0) {
    return {
      drafts,
      refused: [`${request.name}: the server returned nothing.`],
    };
  }
  const encoder = new TextEncoder();
  for (const [index, item] of contents.entries()) {
    if (index >= MAX_RESOURCE_PARTS) {
      refused.push(
        `${request.name}: ${contents.length - MAX_RESOURCE_PARTS} more parts were left out (at most ${MAX_RESOURCE_PARTS} from one resource).`,
      );
      break;
    }
    if (!isRecord(item)) continue;
    const uri = typeof item.uri === "string" ? item.uri : request.uri;
    const name =
      contents.length === 1 || uri === request.uri
        ? request.name
        : labelText(uriTail(uri), 120) || request.name;
    const mime =
      typeof item.mimeType === "string" ? item.mimeType.toLowerCase() : null;
    if (typeof item.text === "string") {
      const size = encoder.encode(item.text).length;
      if (size > MAX_TEXT_ATTACHMENT_BYTES) {
        refused.push(`${name}: ${textTooLarge(size)}`);
        continue;
      }
      drafts.push({
        kind: "text",
        name,
        uri,
        mediaType: mime ?? "text/plain",
        text: item.text,
        size,
      });
    } else if (typeof item.blob === "string") {
      if (!mime?.startsWith("image/")) {
        refused.push(
          `${name}: binary content${mime ? ` (${mime})` : ""} cannot be attached; a resource attaches as text or an image.`,
        );
        continue;
      }
      if (item.blob.length > MAX_IMAGE_SOURCE_BASE64) {
        refused.push(`${name}: the image is too large to attach.`);
        continue;
      }
      if (!BASE64_RE.test(item.blob)) {
        refused.push(`${name}: the server sent a damaged image.`);
        continue;
      }
      drafts.push({
        kind: "image",
        name,
        uri,
        mediaType: mime,
        data: item.blob,
        size: base64Bytes(item.blob),
      });
    }
  }
  return { drafts, refused };
}
