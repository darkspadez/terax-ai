export type PreviewReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type PreviewStatus =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

/**
 * The status after a read of the previewed file. A refresh that fails (the
 * file is mid atomic-rename, or briefly gone) keeps what is on screen.
 */
export function previewAfterRead(
  prev: PreviewStatus,
  read: { ok: true; result: PreviewReadResult } | { ok: false; error: unknown },
): PreviewStatus {
  if (!read.ok) {
    return prev.kind === "ready"
      ? prev
      : { kind: "error", message: String(read.error) };
  }
  const res = read.result;
  if (res.kind === "text") {
    return prev.kind === "ready" && prev.content === res.content
      ? prev
      : { kind: "ready", content: res.content };
  }
  if (res.kind === "binary") return { kind: "binary" };
  return { kind: "toolarge", size: res.size, limit: res.limit };
}
