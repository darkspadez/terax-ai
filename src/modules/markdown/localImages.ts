import { convertFileSrc } from "@tauri-apps/api/core";
import { defaultRehypePlugins, type StreamdownProps } from "streamdown";

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;

/** Attribute naming the workspace file an image resolved to. */
export const LOCAL_IMAGE_PATH = "data-local-path";

// A path relative to the document: no scheme (http:, data:, C: are vetted by
// the sanitizer and harden), not protocol-relative, not root-absolute (that
// would need the repository root, as GitHub resolves it).
function isDocumentRelative(src: string): boolean {
  if (src === "" || src.startsWith("/") || src.startsWith("#")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

/** The folder of a file path, in its own separators; "" without one. */
export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return "";
  return i === 0 ? path.slice(0, 1) : path.slice(0, i);
}

/**
 * Joins a relative reference onto a folder with forward slashes and resolves
 * "." and ".."; ".." never climbs above the root or a drive.
 */
export function joinPath(dir: string, rel: string): string {
  const parts = `${dir}/${rel}`.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "") {
      // Keep a leading root ("/x", "//server/share"), drop doubled separators.
      if (out.length === 0 || out[out.length - 1] === "") out.push(part);
      continue;
    }
    if (part === "..") {
      const last = out[out.length - 1];
      if (last !== undefined && last !== "" && !/^[A-Za-z]:$/.test(last)) {
        out.pop();
      }
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function decodeSrc(src: string): string {
  const path = src.split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Points relative images at the file next to the document, through the
 * asset protocol. Runs after the sanitizer, so an `asset:` URL written into
 * the Markdown itself is still stripped, and before harden, which would
 * otherwise turn "./img.png" into "/img.png" on the app's own origin.
 */
function rehypeLocalImages(baseDir: string) {
  const visit = (node: HastNode) => {
    if (node.type === "element" && node.tagName === "img") {
      const src = node.properties?.src;
      if (typeof src === "string" && isDocumentRelative(src)) {
        const path = joinPath(baseDir, decodeSrc(src));
        node.properties = {
          ...node.properties,
          src: convertFileSrc(path),
          dataLocalPath: path,
        };
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  return (tree: HastNode) => {
    if (baseDir) visit(tree);
  };
}

/** Streamdown's own chain with relative images resolved against `baseDir`. */
export function previewRehypePlugins(baseDir: string): RehypePlugins {
  const plugins: RehypePlugins = [];
  let placed = false;
  for (const [name, plugin] of Object.entries(defaultRehypePlugins)) {
    if (name === "harden") {
      plugins.push([rehypeLocalImages, baseDir]);
      placed = true;
    }
    plugins.push(plugin);
  }
  if (!placed) plugins.push([rehypeLocalImages, baseDir]);
  return plugins;
}
