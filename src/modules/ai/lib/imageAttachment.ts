/** Image types every provider takes. */
const SENDABLE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * The most bytes an image is sent as: Anthropic, the strictest provider,
 * refuses an image over 5 MiB of base64.
 */
export const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);

/** The longest side of an image that has to be encoded again, the most
 *  OpenAI and Anthropic use of one. */
export const MAX_IMAGE_SIDE = 2048;

/** An image is sent as it is, or encoded again (a type a provider refuses,
 *  such as TIFF, BMP or HEIC, or too many bytes). */
export function imageNeedsEncoding(type: string, size: number): boolean {
  return !SENDABLE_TYPES.has(type.toLowerCase()) || size > MAX_IMAGE_BYTES;
}

/** `width` by `height` scaled down to fit `max` on its longer side. */
export function fitWithin(
  width: number,
  height: number,
  max: number = MAX_IMAGE_SIDE,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** `name` with the extension of `type` ("shot.heic" as PNG: "shot.png"). */
export function nameForType(name: string, type: string): string {
  const ext = type === "image/jpeg" ? "jpg" : type.replace(/^image\//, "");
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name || "image"}.${ext}`;
}

function encode(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * An image every provider takes: decoded by the webview, scaled to fit
 * `MAX_IMAGE_SIDE`, as PNG, or JPEG when the PNG is still too large. Null
 * when the webview cannot decode it or it does not fit.
 */
export async function encodeForSending(file: Blob): Promise<File | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const name = file instanceof File ? file.name : "image";
    let blob = await encode(canvas, "image/png");
    let type = "image/png";
    if (!blob || blob.size > MAX_IMAGE_BYTES) {
      // JPEG has no transparency: what was see-through turns white.
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      blob = await encode(canvas, "image/jpeg", 0.85);
      type = "image/jpeg";
    }
    if (!blob || blob.size > MAX_IMAGE_BYTES) return null;
    return new File([blob], nameForType(name, type), {
      type,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

type PartLike = {
  type: string;
  mediaType?: unknown;
  url?: unknown;
  filename?: unknown;
};

/** An image a sent message carries; `key` is its part's place. */
export type MessageImage = { key: string; url: string; name: string };

/**
 * The images a sent message carries, as the chat shows them: inline images
 * only (`data:image/...`), never a URL a stored conversation names.
 */
export function messageImages(parts: readonly PartLike[]): MessageImage[] {
  const images: MessageImage[] = [];
  parts.forEach((part, index) => {
    if (part.type !== "file" || typeof part.url !== "string") return;
    if (!part.url.startsWith("data:image/")) return;
    images.push({
      key: `part-${index}`,
      url: part.url,
      name: typeof part.filename === "string" ? part.filename : "Image",
    });
  });
  return images;
}
