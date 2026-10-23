/**
 * What the agent is told about an MCP tool: its description (capped, since it
 * rides on every request) and its input schema, as the server declares it.
 * Annotations are the server's claims; they are shown to the user and never
 * change approval.
 */

export const MAX_DESCRIPTION_LENGTH = 2048;
/** A larger schema is a server bug or an attempt to flood the prompt. */
export const MAX_SCHEMA_BYTES = 64 * 1024;

export type McpAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** The parts of a listed tool Terax uses (`Tool` in the MCP schema). */
export type McpListedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpAnnotations;
  execution?: { taskSupport?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function toolDescription(tool: McpListedTool): string {
  const title = tool.title?.trim() || tool.annotations?.title?.trim();
  const description = tool.description?.trim() ?? "";
  const text =
    title && !description.startsWith(title)
      ? `${title}${description ? `: ${description}` : ""}`
      : description || title || tool.name;
  return capText(text, MAX_DESCRIPTION_LENGTH);
}

/**
 * The tool's input schema as an object schema, or null when it cannot be
 * offered (not an object, or too large). `$schema` is dropped: some
 * providers refuse keywords they do not know.
 */
export function inputSchemaFor(
  tool: McpListedTool,
): Record<string, unknown> | null {
  const schema = tool.inputSchema;
  if (!isRecord(schema)) return null;
  if (schema.type !== undefined && schema.type !== "object") return null;
  let size: number;
  try {
    size = JSON.stringify(schema).length;
  } catch {
    return null;
  }
  if (size > MAX_SCHEMA_BYTES) return null;
  const rest: Record<string, unknown> = { ...schema };
  delete rest.$schema;
  return {
    ...rest,
    type: "object",
    properties: isRecord(rest.properties) ? rest.properties : {},
  };
}

/** Only these are kept, typed; anything else a server sends is dropped. */
export function cleanAnnotations(raw: unknown): McpAnnotations | undefined {
  if (!isRecord(raw)) return undefined;
  const out: McpAnnotations = {};
  if (typeof raw.title === "string") out.title = capText(raw.title, 200);
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Whether the tool can be called with a plain `tools/call`. A tool that
 * requires task-based execution cannot, so it is not offered.
 */
export function isCallable(tool: McpListedTool): boolean {
  return tool.execution?.taskSupport !== "required";
}

/** The annotations a server put on a tool, worded as its claims. */
export function annotationLabels(annotations?: McpAnnotations): string[] {
  if (!annotations) return [];
  const labels: string[] = [];
  if (annotations.readOnlyHint === true) labels.push("Read-only");
  if (annotations.destructiveHint === true) labels.push("Destructive");
  if (
    annotations.readOnlyHint !== true &&
    annotations.destructiveHint === false
  )
    labels.push("Not destructive");
  if (annotations.idempotentHint === true) labels.push("Idempotent");
  if (annotations.openWorldHint === true)
    labels.push("Reaches outside services");
  if (annotations.openWorldHint === false) labels.push("Closed world");
  return labels;
}
