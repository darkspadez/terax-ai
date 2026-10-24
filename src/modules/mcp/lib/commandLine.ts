/**
 * The command line field of a local server: `npx -y @scope/server --flag`
 * as typed, split into the program and its arguments. Nothing runs through a
 * shell, so only quoting matters: `"..."` (where `\"` and `\\` escape) and
 * `'...'` group words; a backslash elsewhere is literal, so Windows paths
 * need no escaping.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) {
        word += line[i + 1];
        i++;
      } else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** The inverse of `splitCommandLine`: what the field shows for a server. */
export function joinCommandLine(words: readonly string[]): string {
  return words.map(quoteWord).join(" ");
}

function quoteWord(word: string): string {
  if (word === "") return '""';
  if (!/[\s"']/.test(word)) return word;
  if (!word.includes("'")) return `'${word}'`;
  return `"${word.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}
