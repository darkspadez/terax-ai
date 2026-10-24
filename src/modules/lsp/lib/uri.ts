import { pathKey } from "@/lib/pathKey";

export function pathToFileUri(path: string): string {
  let p = path.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  return `file://${p
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(/%3A/g, ":").replace(/%2B/g, "+"),
    )
    .join("/")}`;
}

export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let p = decodeURIComponent(uri.slice("file://".length));
  // Windows drive-letter URIs carry a leading slash (file:///C:/dir), and
  // servers spell the drive either way (pyright sends file:///d%3A/dir).
  if (/^\/[A-Za-z]:\//.test(p)) p = p[1].toUpperCase() + p.slice(2);
  return p;
}

/** Whether two URIs name the same file, whatever their encoding or drive case. */
export function sameFileUri(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = fileUriToPath(a);
  const pb = fileUriToPath(b);
  return pa !== null && pb !== null && pathKey(pa) === pathKey(pb);
}
