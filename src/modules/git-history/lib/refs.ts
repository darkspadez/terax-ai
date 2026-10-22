import type { GitLogRef } from "@/modules/ai/lib/native";

/**
 * The refs a commit row has room for, in order, and the rest behind a count.
 * A commit with exactly one ref over the limit shows it rather than "+1".
 */
export function splitRefs(
  refs: readonly GitLogRef[],
  max: number,
): { shown: readonly GitLogRef[]; hidden: readonly GitLogRef[] } {
  if (refs.length <= max + 1) return { shown: refs, hidden: [] };
  return { shown: refs.slice(0, max), hidden: refs.slice(max) };
}

/** Whether a commit search matches one of its refs (`main`, `v1.0`). */
export function refsMatch(refs: readonly GitLogRef[], query: string): boolean {
  return refs.some((ref) => ref.name.toLowerCase().includes(query));
}
