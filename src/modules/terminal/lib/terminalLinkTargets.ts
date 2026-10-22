import { openExternalUrl } from "@/lib/external-link";
import { authorizeFileFolder } from "@/modules/workspace/authorize";
import { currentWorkspaceEnv } from "@/modules/workspace/env";
import { invoke } from "@tauri-apps/api/core";
import { parseTerminalPathLink } from "../ghostty/core/terminalLinks";
import { openTerminalFile, openTerminalPreview } from "./terminalLinkOpen";

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
 * leading `~`; `localHost` is this machine's name, which `ls --hyperlink` and
 * eza put in their file:// links. Returns null for links that cannot be acted
 * on (a file:// URL on another host, a relative path without a known
 * directory).
 */
export function resolveTerminalLink(
  uri: string,
  cwd: string | null,
  home: string | null,
  localHost: string | null = null,
): TerminalLinkTarget | null {
  if (/^file:\/\//i.test(uri)) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return null;
    }
    if (!isLocalFileHost(url.hostname, localHost)) return null;
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

/** No host, `localhost`, or this machine's name (case aside). */
export function isLocalFileHost(
  host: string,
  localHost: string | null,
): boolean {
  const name = (value: string) => value.toLowerCase().replace(/\.$/, "");
  const host_ = name(host);
  return (
    host_ === "" ||
    host_ === "localhost" ||
    (localHost !== null && host_ === name(localHost))
  );
}

let homeDirectory: Promise<string | null> | undefined;
let localHostName: Promise<string | null> | undefined;

/** See `openTerminalLink`. */
export async function openTerminalLinkTarget(
  uri: string,
  cwd: string | null,
  onExternalSettled: () => void,
): Promise<void> {
  homeDirectory ??= import("@tauri-apps/api/path")
    .then(({ homeDir }) => homeDir())
    .catch(() => null);
  localHostName ??= import("@tauri-apps/plugin-os")
    .then(({ hostname }) => hostname())
    .catch(() => null);
  const target = resolveTerminalLink(
    uri,
    cwd,
    await homeDirectory,
    await localHostName,
  );
  if (!target) return;
  if (target.kind === "external") {
    if (openTerminalPreview(target.url)) return;
    void openExternalUrl(target.url, onExternalSettled);
    return;
  }
  // The user clicked it, so its folder may be reached; terminal output alone
  // never authorizes anything. Detected paths are guesses: open only what exists.
  const workspace = currentWorkspaceEnv();
  await authorizeFileFolder(target.path, workspace);
  const stat = await invoke<{ kind: string }>("fs_stat", {
    path: target.path,
    workspace,
  }).catch(() => null);
  if (!stat) return;
  if (stat.kind !== "dir") {
    openTerminalFile(target.path, target.line, target.column);
  } else if (workspace.kind === "local") {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(target.path).catch(() => {});
  }
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
