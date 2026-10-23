// Eager (the composer reads every message): the rest of a skill call loads on demand.
const INVOCATION_RE = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/;

/** `/skill-name args`: the name and the text after it. */
export function parseSkillInvocation(
  text: string,
): { name: string; args: string } | null {
  const match = INVOCATION_RE.exec(text.trim());
  return match ? { name: match[1], args: (match[2] ?? "").trim() } : null;
}
