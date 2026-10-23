import { invoke } from "@tauri-apps/api/core";

type Clipboard = Pick<DataTransfer, "files" | "items" | "types">;

/**
 * Images on a pasted clipboard, such as a screenshot. WebKit fills either
 * `files` or only `items` depending on the source, so both are read.
 */
export function pastedImages(data: Clipboard): File[] {
  const images = Array.from(data.files).filter((f) =>
    f.type.startsWith("image/"),
  );
  if (images.length > 0) return images;
  const fromItems: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems;
}

/** Text on the clipboard still pastes into the composer; images attach. */
export function pasteKeepsText(data: Clipboard): boolean {
  return Array.from(data.types).includes("text/plain");
}

/**
 * Whether the app reads the clipboard's image itself: the paste brought the
 * webview neither text nor files. WebKitGTK lists an image on the clipboard
 * (a screenshot) as "Files" but hands over no file; WebKit on macOS and
 * WebView2 hand it over. A paste from the primary selection (a middle click
 * on Linux) never does: it does not paste the clipboard.
 */
export function pasteNeedsClipboardImage(
  data: Clipboard,
  fromPrimarySelection: boolean,
): boolean {
  if (fromPrimarySelection || data.files.length > 0) return false;
  if (Array.from(data.items).some((item) => item.kind === "file")) return false;
  return !pasteKeepsText(data);
}

/** The clipboard's image as a file to attach (PNG, as the app reads it). */
export function clipboardImageFile(png: Uint8Array, now: number): File {
  return new File([png as Uint8Array<ArrayBuffer>], "image.png", {
    type: "image/png",
    lastModified: now,
  });
}

/** The clipboard's image, read by the app; null when it holds none. */
export async function readClipboardImageFile(): Promise<File | null> {
  try {
    const png = await invoke<ArrayBuffer>("clipboard_image_read");
    if (png.byteLength === 0) return null;
    return clipboardImageFile(new Uint8Array(png), Date.now());
  } catch {
    return null;
  }
}
