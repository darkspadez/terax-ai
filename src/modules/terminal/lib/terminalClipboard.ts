import { isTauri } from "@tauri-apps/api/core";

/**
 * What a terminal program puts on the clipboard: text, or an image (any type
 * the webview decodes) with the text to put there should it not decode.
 */
export type TerminalClipboardContent =
  | string
  | {
      readonly mime: string;
      readonly data: Uint8Array<ArrayBuffer>;
      readonly text?: string;
    };

/**
 * How long one clipboard image read answers later ones: a paste event's
 * mode 5522 listing and the program's read that follows it, or a listing
 * and its read, share one read (and one PNG encoding).
 */
const IMAGE_READ_REUSE_MS = 1000;

let imageRead: { at: number; image: Promise<Uint8Array | null> } | null = null;

export async function readTerminalClipboard(): Promise<string> {
  try {
    if (isTauri()) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    }
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

export async function writeTerminalClipboard(text: string): Promise<void> {
  imageRead = null;
  if (isTauri()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  if (!navigator.clipboard) throw new Error("Clipboard is unavailable");
  await navigator.clipboard.writeText(text);
}

/** Linux primary selection (copy-on-select, middle-click paste); a no-op elsewhere. */
export async function writePrimarySelection(text: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_primary_selection_write", { text });
  } catch {
    /* no primary selection on this platform or session */
  }
}

/** The Linux primary selection, or null where there is none. */
export async function readPrimarySelection(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string | null>("terminal_primary_selection_read");
  } catch {
    return null;
  }
}

/**
 * The clipboard's image as PNG; null when it holds none (or outside the
 * app). Reads close together share one.
 */
export function readClipboardImage(): Promise<Uint8Array | null> {
  const now = Date.now();
  if (imageRead && now - imageRead.at < IMAGE_READ_REUSE_MS) {
    return imageRead.image;
  }
  const image = fetchClipboardImage();
  imageRead = { at: now, image };
  return image;
}

async function fetchClipboardImage(): Promise<Uint8Array | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const png = await invoke<ArrayBuffer>("clipboard_image_read");
    return png.byteLength > 0 ? new Uint8Array(png) : null;
  } catch {
    return null;
  }
}

/** Puts an image on the clipboard, converted to PNG when it is another type. */
export async function writeClipboardImage(
  data: Uint8Array<ArrayBuffer>,
  mime: string,
): Promise<void> {
  imageRead = null;
  if (!isTauri()) throw new Error("Clipboard images need the app");
  const png = mime.toLowerCase() === "image/png" ? data : await toPng(data, mime);
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("clipboard_image_write", png);
  } finally {
    imageRead = null;
  }
}

/** Text or an image from a program, the image's text should it not decode. */
export async function writeTerminalClipboardContent(
  content: TerminalClipboardContent,
): Promise<void> {
  if (typeof content === "string") return writeTerminalClipboard(content);
  try {
    await writeClipboardImage(content.data, content.mime);
  } catch (error) {
    if (content.text === undefined) throw error;
    await writeTerminalClipboard(content.text);
  }
}

/** An image the webview decodes, as PNG. */
async function toPng(data: Uint8Array<ArrayBuffer>, mime: string): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([data], { type: mime }));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas to convert the image");
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("The image could not be converted");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
