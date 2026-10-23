/** The Agent Skills name rule (`frontmatter::validate_name`), for live feedback in forms. */
const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;

export function skillNameError(name: string): string | null {
  if (name.length === 0) return "Enter a name";
  if (name.length > MAX_SKILL_NAME)
    return `At most ${MAX_SKILL_NAME} characters`;
  if (/[A-Z]/.test(name)) return "Use lowercase letters";
  if (!/^[a-z0-9-]+$/.test(name))
    return "Only lowercase letters, digits and hyphens";
  if (name.startsWith("-") || name.endsWith("-"))
    return "No hyphen at the start or end";
  if (name.includes("--")) return "No two hyphens in a row";
  return null;
}

/** A name typed in a form: spaces and underscores become hyphens, letters lowercase. */
export function normalizeSkillName(input: string): string {
  return input.toLowerCase().replace(/[\s_]+/g, "-");
}
