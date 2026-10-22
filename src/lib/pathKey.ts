/**
 * Comparable form of a local path: forward slashes, an upper-case Windows
 * drive letter and no trailing separator. Paths reach the frontend from the
 * OS, git, OSC 7 and language servers in different spellings of the same
 * file.
 */
export function pathKey(path: string): string {
  let key = path.replace(/\\/g, "/");
  if (/^[a-z]:/.test(key)) key = key[0].toUpperCase() + key.slice(1);
  if (key.length > 1 && key.endsWith("/") && !/^[A-Za-z]:\/$/.test(key)) {
    key = key.replace(/\/+$/, "");
  }
  return key;
}
