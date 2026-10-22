import { parseTerminalPathLink } from "../ghostty/core/terminalLinks";

/** What clicking a terminal link does. */
export type TerminalLinkTarget =
  | { readonly kind: "external"; readonly url: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly line: number | null;
      readonly column: number | null;
    };

/**
 * Classifies a link (an OSC 8 URI, a detected URL or a detected path) and
 * resolves paths against the terminal's working directory. `home` expands a
 * leading `~`. Returns null for links that cannot be acted on (a file:// URL
 * on another host, a relative path without a known directory).
 */
export function resolveTerminalLink(
  uri: string,
  cwd: string | null,
  home: string | null,
): TerminalLinkTarget | null {
  if (/^file:\/\//i.test(uri)) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return null;
    }
    if (url.hostname && url.hostname !== "localhost") return null;
    let path = decodeURIComponent(url.pathname);
    // file:///C:/dir -> C:/dir
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    const position = /^L?(\d+)(?:[:,]C?(\d+))?$/i.exec(url.hash.slice(1));
    return {
      kind: "file",
      path,
      line: position ? Number(position[1]) : null,
      column: position?.[2] ? Number(position[2]) : null,
    };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(uri) && !/^[A-Za-z]:[\\/]/.test(uri)) {
    return { kind: "external", url: uri };
  }
  const parsed = parseTerminalPathLink(uri);
  if (!parsed) return null;
  let path = parsed.path;
  if (path === "~" || path.startsWith("~/")) {
    if (!home) return null;
    path = joinPath(home, path.slice(2));
  } else if (!isAbsolutePath(path)) {
    if (!cwd) return null;
    path = joinPath(cwd, path);
  }
  return { kind: "file", path, line: parsed.line, column: parsed.column };
}

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}

/** Joins and normalizes `.`/`..` segments, keeping the base's separator. */
export function joinPath(base: string, relative: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const root = /^[A-Za-z]:[\\/]/.test(base)
    ? base.slice(0, 3)
    : base.startsWith("/")
      ? "/"
      : "";
  const segments: string[] = [];
  for (const part of `${base.slice(root.length)}/${relative}`.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return root.replace(/[\\/]$/, separator) + segments.join(separator);
}

type FileOpener = (
  path: string,
  line: number | null,
  column: number | null,
) => void;

let fileOpener: FileOpener | null = null;

/** The app's editor registers how to open a file (at a line) from a terminal. */
export function setTerminalFileOpener(opener: FileOpener | null): void {
  fileOpener = opener;
}

/** Opens a file in the editor; false when no editor is registered. */
export function openTerminalFile(
  path: string,
  line: number | null,
  column: number | null,
): boolean {
  if (!fileOpener) return false;
  fileOpener(path, line, column);
  return true;
}
