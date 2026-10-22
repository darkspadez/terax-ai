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
