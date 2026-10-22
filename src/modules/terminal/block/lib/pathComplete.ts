import { IS_WINDOWS } from "@/lib/platform";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  type Completion,
  startCompletion,
} from "@codemirror/autocomplete";
import { invoke } from "@tauri-apps/api/core";

type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

export type PathResult = { fromOffset: number; options: Completion[] };

/** Path syntax of the shell behind the command bar. A local Windows shell
 * takes backslashes and drive letters; WSL and Unix shells are POSIX, where a
 * backslash escapes the next character. */
export type PathStyle = "posix" | "windows";

export function currentPathStyle(): PathStyle {
  return IS_WINDOWS && currentWorkspaceEnv().kind === "local"
    ? "windows"
    : "posix";
}

const COMPLETION_WORD: Record<PathStyle, RegExp> = {
  posix: /[\w./+-]*/,
  windows: /[\w./\\:+-]*/,
};

// A listed entry stays valid until the next separator, which lists its level.
const PATH_VALID_FOR: Record<PathStyle, RegExp> = {
  posix: /^[^/]*$/,
  windows: /^[^/\\]*$/,
};

/** The token before the cursor that command and path completion work on. */
export function completionWord(style: PathStyle): RegExp {
  return COMPLETION_WORD[style];
}

export function pathValidFor(style: PathStyle): RegExp {
  return PATH_VALID_FOR[style];
}

function joinRel(cwd: string, rel: string): string {
  const clean = rel.replace(/\/$/, "");
  if (!clean) return cwd;
  return cwd.endsWith("/") ? `${cwd}${clean}` : `${cwd}/${clean}`;
}

function resolveDir(
  dirPart: string,
  cwd: string,
  style: PathStyle,
): string | null {
  if (dirPart.startsWith("~")) return null; // home expansion not handled yet
  if (style === "windows") {
    if (/^[a-zA-Z]:\//.test(dirPart) || dirPart.startsWith("//"))
      return dirPart;
    // `\dir` is rooted on the drive of the shell's cwd, not the app's.
    const drive = /^[a-zA-Z]:/.exec(cwd);
    if (dirPart.startsWith("/"))
      return drive ? `${drive[0]}${dirPart}` : dirPart;
    return joinRel(cwd, dirPart);
  }
  if (dirPart.startsWith("/")) return dirPart;
  return joinRel(cwd, dirPart);
}

type PathQuery = {
  dir: string;
  base: string;
  fromOffset: number;
  sep: "/" | "\\";
};

/** Splits the token into the directory to list and the name prefix to match.
 * Windows separators are swapped one for one, so offsets stay those of the
 * typed token, and directories take the separator the user typed. */
export function pathQuery(
  token: string,
  cwd: string,
  style: PathStyle,
): PathQuery | null {
  const windows = style === "windows";
  const path = windows ? token.replace(/\\/g, "/") : token;
  const slash = path.lastIndexOf("/");
  const dirPart = path.slice(0, slash + 1);
  const dir = resolveDir(
    dirPart,
    windows ? cwd.replace(/\\/g, "/") : cwd,
    style,
  );
  if (dir === null) return null;
  return {
    dir,
    base: path.slice(slash + 1),
    fromOffset: dirPart.length,
    sep: windows && token[slash] === "\\" ? "\\" : "/",
  };
}

// Completes the argument token against the terminal's live cwd. Directories get
// a trailing separator and re-trigger completion so the next level opens on accept.
export async function pathCompletions(
  token: string,
  cwd: string,
  style: PathStyle,
): Promise<PathResult | null> {
  const query = pathQuery(token, cwd, style);
  if (!query) return null;
  const { dir, base, fromOffset, sep } = query;

  let entries: DirEntry[];
  try {
    entries = await invoke<DirEntry[]>("fs_read_dir", {
      path: dir,
      showHidden: base.startsWith("."),
      workspace: currentWorkspaceEnv(),
    });
  } catch {
    return null;
  }

  const lower = base.toLowerCase();
  const dirs: Completion[] = [];
  const files: Completion[] = [];
  for (const e of entries) {
    if (lower && !e.name.toLowerCase().startsWith(lower)) continue;
    const isDir = e.kind === "dir";
    if (isDir) {
      const insert = `${e.name}${sep}`;
      dirs.push({
        label: insert,
        type: "type",
        apply: (view, _c, from, to) => {
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length },
          });
          startCompletion(view);
        },
      });
    } else {
      files.push({ label: e.name, type: "variable" });
    }
    if (dirs.length + files.length >= 200) break;
  }

  return { fromOffset, options: [...dirs, ...files] };
}
