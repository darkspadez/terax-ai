import type { WorkspaceEnv } from "@/modules/workspace";

/**
 * Skills invoked by the user (`/skill-name ...` in the composer, read by `slash.ts`) and the
 * text substitutions of Claude Code's skills: `${CLAUDE_SKILL_DIR}` everywhere, and with the
 * user's arguments `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N`; `\$` keeps a dollar sign.
 */

/** Splits arguments on whitespace; quotes group words and are removed. */
export function splitArguments(args: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of args) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

const ESCAPED_DOLLAR = "\u0000";

function replaceEvery(text: string, from: string, to: string): string {
  return text.split(from).join(to);
}

/**
 * The skill's text with its variables replaced. Without `args` (the model loaded the skill)
 * only the folder is filled in; an index past the arguments stays as written.
 */
export function expandSkillText(
  body: string,
  { dir, args }: { dir: string; args?: string },
): string {
  let text = replaceEvery(body, "\\$", ESCAPED_DOLLAR);
  text = text.replace(/\$\{CLAUDE_SKILL_DIR\}/g, () => dir);
  if (args !== undefined) {
    const list = splitArguments(args);
    text = text.replace(
      /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$(\d+)(?!\d)/g,
      (
        whole: string,
        indexed: string | undefined,
        positional: string | undefined,
      ) => {
        const index = indexed ?? positional;
        if (index === undefined) return args;
        return list[Number(index)] ?? whole;
      },
    );
  }
  return replaceEvery(text, ESCAPED_DOLLAR, "$");
}

/** A host path as a shell in `env` reaches it: in a WSL conversation `C:/x` is `/mnt/c/x`. */
export function pathForWorkspace(path: string, env: WorkspaceEnv): string {
  if (env.kind !== "wsl") return path;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!match) return path;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/**
 * The block a user-invoked skill adds before their message: the instructions, introduced so the
 * model knows where they came from. A closing tag inside them is escaped so the block stays one.
 */
export function skillMessageBlock(
  name: string,
  dir: string,
  content: string,
): string {
  const safe = replaceEvery(content, "</skill>", "<\\/skill>");
  return `<skill name="${escapeAttribute(name)}" dir="${escapeAttribute(dir)}">
The user invoked the skill "${name}". Follow its instructions below for their message. Its files are in ${dir}: read them with read_skill_file, run its scripts with bash_run.

${safe.trim()}
</skill>`;
}

/** Matches a skill block in a sent message, for the chat's context chips. */
export const SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g;
