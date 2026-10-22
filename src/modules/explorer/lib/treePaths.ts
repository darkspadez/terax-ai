/**
 * The folder holding a tree path (tree paths are joined with `/`). A drive
 * root keeps its slash: `D:` alone is the current folder on drive D, not its
 * root, so `D:/a` lives in `D:/`.
 */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "/";
  if (i === 2 && /^[A-Za-z]:\//.test(path)) return path.slice(0, 3);
  return path.slice(0, i);
}
