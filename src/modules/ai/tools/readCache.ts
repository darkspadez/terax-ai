const utf8 = new TextEncoder();

export function contentHash(content: string): number {
  let h = 5381;
  for (let i = 0; i < content.length; i++)
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** The read-cache entry for content just written. `size` is in UTF-8 bytes,
 * the unit fs_read_file reports, so the next full read of the unchanged file
 * is answered with `unchanged`. */
export function writtenEntry(content: string): { size: number; hash: number } {
  return { size: utf8.encode(content).length, hash: contentHash(content) };
}
