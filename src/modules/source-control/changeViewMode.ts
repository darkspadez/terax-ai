/** How Source Control shows changed files: a flat list or grouped by folder. */
export type ChangeViewMode = "list" | "tree";

export function parseChangeViewMode(value: unknown): ChangeViewMode {
  return value === "tree" ? "tree" : "list";
}
