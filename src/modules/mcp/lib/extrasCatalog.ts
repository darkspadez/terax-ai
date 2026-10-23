import { create } from "zustand";
import { bodyText, labelText } from "./displayText";

/**
 * What the window's running MCP servers offer besides tools: resources and
 * resource templates (the composer's `@` picker) and prompts (its `/` list).
 * The client runtime lists them, cleans them here and publishes them; the
 * composer reads the store without loading the client. Everything in it was
 * written by a server: shown as that server's, never trusted.
 */

export type McpResourceEntry = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

export type McpTemplateEntry = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** The template's variables, in order: the fields of its form. */
  variables: string[];
  /** Variables of query expansions (`{?x}`, `{&x}`), which may stay empty. */
  optional: string[];
};

type McpPromptArgument = {
  name: string;
  title?: string;
  description?: string;
  required: boolean;
};

export type McpPromptEntry = {
  name: string;
  title?: string;
  description?: string;
  arguments: McpPromptArgument[];
};

export type McpServerExtras = {
  serverId: string;
  serverName: string;
  resources: McpResourceEntry[];
  templates: McpTemplateEntry[];
  prompts: McpPromptEntry[];
  /** It answers `completion/complete` for prompt and template arguments. */
  completions: boolean;
};

export const MAX_RESOURCES = 500;
export const MAX_TEMPLATES = 100;
export const MAX_PROMPTS = 200;
const MAX_ARGUMENTS = 20;
/** A longer URI is not offered: shortening it would name something else. */
export const MAX_URI_LENGTH = 2048;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** A name or URI used to address something on the server: kept exactly, or refused. */
function addressOf(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value || value.length > max) return null;
  return CONTROL_RE.test(value) ? null : value;
}

function optionalLabel(value: unknown): string | undefined {
  const text = labelText(value, MAX_NAME);
  return text || undefined;
}

function optionalBody(value: unknown): string | undefined {
  const text = bodyText(value, MAX_DESCRIPTION).trim();
  return text || undefined;
}

function mimeOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(value)
    ? value.toLowerCase()
    : undefined;
}

/** A `resources/list` page set as the picker shows it: deduplicated, capped. */
export function cleanResources(raw: readonly unknown[]): McpResourceEntry[] {
  const out: McpResourceEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_RESOURCES) break;
    if (!isRecord(entry)) continue;
    const uri = addressOf(entry.uri, MAX_URI_LENGTH);
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push({
      uri,
      name: labelText(entry.name, MAX_NAME) || labelText(uri, MAX_NAME),
      title: optionalLabel(entry.title),
      description: optionalBody(entry.description),
      mimeType: mimeOf(entry.mimeType),
    });
  }
  return out;
}

/** Variables a template may leave out: those of `{?...}` and `{&...}`. */
export function optionalVariables(template: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(/\{([?&])([^}]*)\}/g)) {
    for (const part of match[2].split(",")) {
      const name = part.replace(/(\*|:\d+)$/, "").trim();
      if (name) out.push(name);
    }
  }
  return out;
}

/**
 * Resource templates with their variables; `variablesOf` parses a template
 * (RFC 6570) and returns null when it cannot, which drops it.
 */
export function cleanTemplates(
  raw: readonly unknown[],
  variablesOf: (template: string) => string[] | null,
): McpTemplateEntry[] {
  const out: McpTemplateEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_TEMPLATES) break;
    if (!isRecord(entry)) continue;
    const uriTemplate = addressOf(entry.uriTemplate, MAX_URI_LENGTH);
    if (!uriTemplate || seen.has(uriTemplate)) continue;
    let variables: string[] | null;
    try {
      variables = variablesOf(uriTemplate);
    } catch {
      variables = null;
    }
    if (!variables) continue;
    const names = [...new Set(variables)];
    if (
      names.length > MAX_ARGUMENTS ||
      names.some((name) => !addressOf(name, MAX_NAME))
    ) {
      continue;
    }
    seen.add(uriTemplate);
    out.push({
      uriTemplate,
      name: labelText(entry.name, MAX_NAME) || labelText(uriTemplate, MAX_NAME),
      title: optionalLabel(entry.title),
      description: optionalBody(entry.description),
      mimeType: mimeOf(entry.mimeType),
      variables: names,
      optional: optionalVariables(uriTemplate).filter((n) => names.includes(n)),
    });
  }
  return out;
}

function cleanArguments(raw: unknown): McpPromptArgument[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ARGUMENTS) return null;
  const out: McpPromptArgument[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const name = addressOf(entry.name, MAX_NAME);
    if (!name || seen.has(name)) return null;
    seen.add(name);
    out.push({
      name,
      title: optionalLabel(entry.title),
      description: optionalBody(entry.description),
      required: entry.required === true,
    });
  }
  return out;
}

/** `prompts/list` as the slash list shows it; a prompt with malformed arguments is dropped. */
export function cleanPrompts(raw: readonly unknown[]): McpPromptEntry[] {
  const out: McpPromptEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_PROMPTS) break;
    if (!isRecord(entry)) continue;
    const name = addressOf(entry.name, MAX_NAME);
    if (!name || seen.has(name)) continue;
    const args = cleanArguments(entry.arguments);
    if (!args) continue;
    seen.add(name);
    out.push({
      name,
      title: optionalLabel(entry.title),
      description: optionalBody(entry.description),
      arguments: args,
    });
  }
  return out;
}

type ExtrasState = {
  /** Running servers that offer resources or prompts, in Settings order. */
  servers: McpServerExtras[];
  /** Servers are starting for the composer (its pickers say so). */
  starting: boolean;
  setServers: (servers: McpServerExtras[]) => void;
  setStarting: (starting: boolean) => void;
};

export const useMcpExtras = create<ExtrasState>((set) => ({
  servers: [],
  starting: false,
  setServers: (servers) => set({ servers }),
  setStarting: (starting) => set({ starting }),
}));
