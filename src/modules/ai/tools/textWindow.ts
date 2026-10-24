/** What one read returns of a text file: at most 2000 lines and 25 KB. */
const READ_BYTE_CAP = 25 * 1024;
const READ_LINE_CAP = 2000;

export type TextWindow = {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  /** More follows: past `endLine`, or cut at the byte cap. */
  truncated: boolean;
};

/** Lines `offset` to `offset + limit` of `text`, cut at `READ_BYTE_CAP`. */
export function textWindow(
  text: string,
  offset = 0,
  limit = READ_LINE_CAP,
): TextWindow {
  const lines = text.split("\n");
  const end = Math.min(lines.length, offset + limit);
  let content = lines.slice(offset, end).join("\n");
  let truncated = end < lines.length;
  if (content.length > READ_BYTE_CAP) {
    content = content.slice(0, READ_BYTE_CAP);
    truncated = true;
  }
  return {
    content,
    totalLines: lines.length,
    startLine: offset,
    endLine: end,
    truncated,
  };
}
