import { invoke } from "@tauri-apps/api/core";
import { authorizeFileFolder, currentWorkspaceEnv } from "@/modules/workspace";
import type { ReadResult } from "./native";

/** The most text one file attachment carries into the prompt, however added. */
export const MAX_TEXT_ATTACHMENT_BYTES = 200_000;

const kb = (bytes: number) => `${Math.ceil(bytes / 1000)} KB`;

/** A file read for an attachment: its text, or why it is not attached. */
export function attachableText(
  result: ReadResult,
): { ok: true; text: string; size: number } | { ok: false; reason: string } {
  if (result.kind === "binary") {
    return { ok: false, reason: "It is not a text file." };
  }
  if (result.kind === "toolarge" || result.size > MAX_TEXT_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: `It is ${kb(result.size)}; a text attachment holds up to ${kb(MAX_TEXT_ATTACHMENT_BYTES)}.`,
    };
  }
  return { ok: true, text: result.content, size: result.size };
}

/** The file name a path's attachment chip shows. */
export function attachmentName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** A refusal from the agent's own read checks, worded for the user. */
export function agentReadRefusal(reason: string): string {
  const text = reason.replace(/^Refused:\s*/, "");
  return `The agent may not read it: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** A file the user picked (Attach to Agent, an @ mention): its folder is
 *  authorized, as when the user opens it, and the app reads it. */
export async function readPickedFile(path: string): Promise<ReadResult> {
  await authorizeFileFolder(path);
  return invoke<ReadResult>("fs_read_file", {
    path,
    workspace: currentWorkspaceEnv(),
  });
}

/**
 * A file dropped on the composer, read as the agent's read_file reads it:
 * the secret-path deny-list on the path and its real path, and the backend's
 * gates for the AI tools (`origin: "ai"`: the authorized folders, unless the
 * AI may access all folders). Nothing is authorized, so a drop never hands
 * the AI a file it could not read itself. The checks load with the tools.
 */
export async function readDroppedFile(path: string): Promise<ReadResult> {
  const [{ native }, { checkReadableCanonical }] = await Promise.all([
    import("./native"),
    import("./security"),
  ]);
  const safety = await checkReadableCanonical(path, native.canonicalize);
  if (!safety.ok) throw new Error(agentReadRefusal(safety.reason));
  return native.readFile(safety.canonical);
}
