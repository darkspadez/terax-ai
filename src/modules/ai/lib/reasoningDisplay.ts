type DisplayPart = { type: string; text?: string; state?: string };

/**
 * OpenAI-compatible streams that alternate `reasoning_content` and `content`
 * (MiniMax) reach the chat as reasoning, text, reasoning, text, ... parts,
 * because the SDK ends the open part whenever the other kind arrives: one
 * answer showed several reasoning blocks, some after the answer. For display,
 * each run of reasoning and text parts (bounded by step starts, tool calls
 * and anything else) becomes one reasoning block followed by one text part,
 * each the run's fragments in order. Runs never merge across a boundary, so
 * multi-step turns keep their order. The stored parts are untouched; the
 * same array comes back when nothing needs merging.
 */
export function mergeInterleavedReasoning<T extends DisplayPart>(
  parts: readonly T[],
): readonly T[] {
  const out: T[] = [];
  let changed = false;
  let run: T[] = [];
  const flush = () => {
    const merged = [
      mergeParts(run.filter((p) => p.type === "reasoning")),
      mergeParts(run.filter((p) => p.type === "text")),
    ].filter((p): p is T => p !== null);
    if (merged.some((p, i) => p !== run[i])) changed = true;
    out.push(...merged);
    run = [];
  };
  for (const part of parts) {
    if (part.type === "reasoning" || part.type === "text") {
      run.push(part);
      continue;
    }
    flush();
    out.push(part);
  }
  flush();
  return changed ? out : parts;
}

function mergeParts<T extends DisplayPart>(parts: readonly T[]): T | null {
  if (parts.length <= 1) return parts[0] ?? null;
  // Fragments of one stream: joined as sent.
  return {
    ...parts[0],
    text: parts.map((p) => p.text ?? "").join(""),
    ...(parts.some((p) => p.state === "streaming")
      ? { state: "streaming" }
      : {}),
  };
}
