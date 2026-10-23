/**
 * Text an MCP server wrote, made safe to show: no control characters (a
 * label keeps none, a body keeps line breaks and tabs), no bidi controls
 * that could reorder what is around it, and capped. React escapes the rest.
 * Pure.
 */

function isHidden(code: number, keepLines: boolean): boolean {
  if (keepLines && (code === 0x0a || code === 0x09)) return false;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function clean(value: unknown, max: number, keepLines: boolean): string {
  if (typeof value !== "string") return "";
  let out = "";
  let count = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0d) continue;
    if (isHidden(code, keepLines)) {
      const breaks =
        (code >= 0x09 && code <= 0x0c) || code === 0x2028 || code === 0x2029;
      if (breaks && out && !out.endsWith(" ")) out += " ";
      continue;
    }
    if (count === max) return `${out.trimEnd()}…`;
    out += char;
    count += 1;
  }
  return keepLines ? out : out.trim();
}

/** A one-line label (a name, a title, a URI). */
export function labelText(value: unknown, max = 200): string {
  return clean(value, max, false);
}

/** Text that keeps its lines (a description, a message). */
export function bodyText(value: unknown, max = 2000): string {
  return clean(value, max, true);
}
