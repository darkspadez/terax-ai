import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { IS_MAC } from "@/lib/platform";
import { currentWorkspaceEnv } from "@/modules/workspace";

export const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : "Reveal in File Manager";

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best-effort; ignore in environments without clipboard permission.
  }
}

export function relativePath(rootPath: string, path: string): string {
  if (path === rootPath) return ".";
  if (path.startsWith(`${rootPath}/`)) return path.slice(rootPath.length + 1);
  return path;
}

export async function revealInFinder(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("revealItemInDir failed:", e);
  }
}

/** Opens a file in the app the OS associates with it (images, PDFs, office files). */
export async function openInDefaultApp(path: string): Promise<void> {
  try {
    await invoke("fs_open_default", {
      path,
      workspace: currentWorkspaceEnv(),
    });
  } catch (e) {
    toast.error("Could not open the file", { description: String(e) });
  }
}
