/**
 * What the Refresh action re-reads: the root, every loaded listing (collapsed
 * folders keep theirs) and every expanded folder, even one still loading.
 * Re-reading only the root left a stale subfolder stale, which the WSL share,
 * with no change notifications of its own, made easy to hit.
 */
export function refreshTargets(
  rootPath: string | null,
  nodes: Readonly<Record<string, { status: string }>>,
  expanded: Iterable<string>,
): string[] {
  if (!rootPath) return [];
  const targets = new Set<string>();
  for (const [path, state] of Object.entries(nodes)) {
    if (state.status === "loaded") targets.add(path);
  }
  for (const path of expanded) targets.add(path);
  targets.delete(rootPath);
  return [rootPath, ...[...targets].sort()];
}
