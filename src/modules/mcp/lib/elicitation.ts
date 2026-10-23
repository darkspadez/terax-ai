import { bodyText, labelText } from "./displayText";

/**
 * An MCP elicitation form (`elicitation/create`, form mode): the requested
 * schema as fields, the values the user typed, and what is sent back.
 * Only the spec's flat primitive fields are supported (string with length
 * and format, number and integer with bounds, boolean, single and multiple
 * choice with or without labels); anything else makes the whole form
 * unsupported, with the reason. Values are checked against the schema
 * before anything is sent. Pure.
 */

const MAX_FIELDS = 30;
const MAX_OPTIONS = 200;
const MAX_STRING_INPUT = 10_000;

type Base = {
  name: string;
  label: string;
  description?: string;
  required: boolean;
};

type StringFormat = "email" | "uri" | "date" | "date-time";

type ElicitOption = { value: string; label: string };

export type ElicitField =
  | (Base & {
      kind: "string";
      minLength?: number;
      maxLength?: number;
      format?: StringFormat;
      default?: string;
    })
  | (Base & {
      kind: "number";
      integer: boolean;
      minimum?: number;
      maximum?: number;
      default?: number;
    })
  | (Base & { kind: "boolean"; default?: boolean })
  | (Base & { kind: "choice"; options: ElicitOption[]; default?: string })
  | (Base & {
      kind: "multi";
      options: ElicitOption[];
      minItems?: number;
      maxItems?: number;
      default?: string[];
    });

/** What a field holds while the user edits it. */
export type ElicitValue = string | boolean | string[];
export type ElicitValues = Record<string, ElicitValue>;
export type ElicitContent = Record<
  string,
  string | number | boolean | string[]
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

const FORMATS: ReadonlySet<string> = new Set([
  "email",
  "uri",
  "date",
  "date-time",
]);

function plainOptions(raw: unknown, names: unknown): ElicitOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPTIONS) {
    return null;
  }
  if (!raw.every((v): v is string => typeof v === "string")) return null;
  const labels =
    Array.isArray(names) && names.length === raw.length ? names : null;
  return raw.map((value, i) => ({
    value,
    label: labelText(labels?.[i], 120) || labelText(value, 120) || value,
  }));
}

function titledOptions(raw: unknown): ElicitOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPTIONS) {
    return null;
  }
  const out: ElicitOption[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.const !== "string") return null;
    out.push({
      value: entry.const,
      label:
        labelText(entry.title, 120) ||
        labelText(entry.const, 120) ||
        entry.const,
    });
  }
  return out;
}

function unique(options: ElicitOption[]): boolean {
  return new Set(options.map((o) => o.value)).size === options.length;
}

function fieldOf(
  name: string,
  raw: unknown,
  required: boolean,
): ElicitField | string {
  if (!isRecord(raw)) return `The field "${name}" has no schema.`;
  const base: Base = {
    name,
    label: labelText(raw.title, 120) || labelText(name, 120) || name,
    description: bodyText(raw.description, 600).trim() || undefined,
    required,
  };
  const unsupported = `The field "${base.label}" asks for a kind of value Oarlock's forms do not support.`;
  switch (raw.type) {
    case "string": {
      if (raw.enum !== undefined || raw.oneOf !== undefined) {
        const options =
          raw.enum !== undefined
            ? plainOptions(raw.enum, raw.enumNames)
            : titledOptions(raw.oneOf);
        if (!options || !unique(options)) return unsupported;
        const fallback =
          typeof raw.default === "string" &&
          options.some((o) => o.value === raw.default)
            ? raw.default
            : undefined;
        return { ...base, kind: "choice", options, default: fallback };
      }
      if (raw.format !== undefined && !FORMATS.has(String(raw.format))) {
        return unsupported;
      }
      return {
        ...base,
        kind: "string",
        minLength: count(raw.minLength),
        maxLength: count(raw.maxLength),
        format: raw.format as StringFormat | undefined,
        default: typeof raw.default === "string" ? raw.default : undefined,
      };
    }
    case "number":
    case "integer":
      return {
        ...base,
        kind: "number",
        integer: raw.type === "integer",
        minimum: finite(raw.minimum),
        maximum: finite(raw.maximum),
        default: finite(raw.default),
      };
    case "boolean":
      return {
        ...base,
        kind: "boolean",
        default: typeof raw.default === "boolean" ? raw.default : undefined,
      };
    case "array": {
      const items = isRecord(raw.items) ? raw.items : null;
      const options = !items
        ? null
        : items.anyOf !== undefined
          ? titledOptions(items.anyOf)
          : items.type === "string"
            ? plainOptions(items.enum, undefined)
            : null;
      if (!options || !unique(options)) return unsupported;
      const known = new Set(options.map((o) => o.value));
      const fallback = Array.isArray(raw.default)
        ? raw.default.filter(
            (v): v is string => typeof v === "string" && known.has(v),
          )
        : undefined;
      return {
        ...base,
        kind: "multi",
        options,
        minItems: count(raw.minItems),
        maxItems: count(raw.maxItems),
        default: fallback,
      };
    }
    default:
      return unsupported;
  }
}

/** The form a requested schema describes, or why Oarlock cannot show it. */
export function elicitationFields(
  schema: unknown,
): { fields: ElicitField[] } | { unsupported: string } {
  if (!isRecord(schema) || schema.type !== "object") {
    return { unsupported: "The requested schema is not an object." };
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const names = Object.keys(properties);
  if (names.length > MAX_FIELDS) {
    return { unsupported: `The form has more than ${MAX_FIELDS} fields.` };
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((n): n is string => typeof n === "string")
      : [],
  );
  const fields: ElicitField[] = [];
  for (const name of names) {
    const field = fieldOf(name, properties[name], required.has(name));
    if (typeof field === "string") return { unsupported: field };
    fields.push(field);
  }
  return { fields };
}

/** Each field's starting value: the schema's default, else empty. */
export function initialValues(fields: readonly ElicitField[]): ElicitValues {
  const values: ElicitValues = {};
  for (const field of fields) {
    switch (field.kind) {
      case "string":
      case "choice":
        values[field.name] = field.default ?? "";
        break;
      case "number":
        values[field.name] =
          field.default === undefined ? "" : String(field.default);
        break;
      case "boolean":
        values[field.name] = field.default ?? false;
        break;
      case "multi":
        values[field.name] = field.default ?? [];
        break;
    }
  }
  return values;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** RFC 3339, or the local form a `datetime-local` input gives. */
const DATE_TIME_RE =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/;

function validDate(text: string): boolean {
  const match = DATE_RE.exec(text);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** A date-time as RFC 3339 (a local one gets this machine's offset), or null. */
function dateTimeValue(text: string): string | null {
  const match = DATE_TIME_RE.exec(text);
  if (!match || !validDate(match[1])) return null;
  const [hour, minute, second] = [
    Number(match[2]),
    Number(match[3]),
    Number(match[4] ?? 0),
  ];
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (match[5]) return text;
  const local = new Date(
    `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`,
  );
  return Number.isNaN(local.getTime()) ? null : local.toISOString();
}

function validUri(text: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(text)) return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function stringError(
  field: Extract<ElicitField, { kind: "string" }>,
  text: string,
): string | null {
  const length = [...text].length;
  if (length > MAX_STRING_INPUT) return "This is too long.";
  if (field.minLength !== undefined && length < field.minLength) {
    return `Enter at least ${plural(field.minLength, "character")}.`;
  }
  if (field.maxLength !== undefined && length > field.maxLength) {
    return `Enter at most ${plural(field.maxLength, "character")}.`;
  }
  switch (field.format) {
    case "email":
      return EMAIL_RE.test(text) ? null : "Enter an email address.";
    case "uri":
      return validUri(text) ? null : "Enter a full address, such as https://…";
    case "date":
      return validDate(text) ? null : "Enter a date as YYYY-MM-DD.";
    case "date-time":
      return dateTimeValue(text) ? null : "Enter a date and time.";
    default:
      return null;
  }
}

/**
 * What the user filled in, checked against the fields: an error per field
 * that is not right, or the content to send (typed as the schema says;
 * empty optional fields are left out).
 */
export function validateElicitation(
  fields: readonly ElicitField[],
  values: ElicitValues,
): { errors: Record<string, string>; content: ElicitContent | null } {
  const errors: Record<string, string> = {};
  const content: ElicitContent = {};
  for (const field of fields) {
    const value = values[field.name];
    switch (field.kind) {
      case "boolean":
        content[field.name] = value === true;
        break;
      case "multi": {
        const known = new Set(field.options.map((o) => o.value));
        const picked = Array.isArray(value)
          ? field.options
              .map((o) => o.value)
              .filter((v) => value.includes(v) && known.has(v))
          : [];
        if (picked.length === 0 && !field.required) break;
        if (field.required && picked.length === 0) {
          errors[field.name] = "Choose at least one.";
        } else if (
          field.minItems !== undefined &&
          picked.length < field.minItems
        ) {
          errors[field.name] = `Choose at least ${field.minItems}.`;
        } else if (
          field.maxItems !== undefined &&
          picked.length > field.maxItems
        ) {
          errors[field.name] = `Choose at most ${field.maxItems}.`;
        } else {
          content[field.name] = picked;
        }
        break;
      }
      case "choice": {
        const text = typeof value === "string" ? value : "";
        if (!text) {
          if (field.required) errors[field.name] = "Choose one.";
          break;
        }
        if (!field.options.some((o) => o.value === text)) {
          errors[field.name] = "Choose one of the options.";
          break;
        }
        content[field.name] = text;
        break;
      }
      case "number": {
        const text = typeof value === "string" ? value.trim() : "";
        if (!text) {
          if (field.required) errors[field.name] = "Enter a number.";
          break;
        }
        const number = Number(text);
        if (!Number.isFinite(number)) {
          errors[field.name] = "Enter a number.";
        } else if (field.integer && !Number.isInteger(number)) {
          errors[field.name] = "Enter a whole number.";
        } else if (field.minimum !== undefined && number < field.minimum) {
          errors[field.name] = `Enter ${field.minimum} or more.`;
        } else if (field.maximum !== undefined && number > field.maximum) {
          errors[field.name] = `Enter ${field.maximum} or less.`;
        } else {
          content[field.name] = number;
        }
        break;
      }
      case "string": {
        const raw = typeof value === "string" ? value : "";
        const text = field.format ? raw.trim() : raw;
        if (!text.trim()) {
          if (field.required) errors[field.name] = "This is required.";
          break;
        }
        const error = stringError(field, text);
        if (error) {
          errors[field.name] = error;
          break;
        }
        content[field.name] =
          field.format === "date-time" ? (dateTimeValue(text) ?? text) : text;
        break;
      }
    }
  }
  return {
    errors,
    content: Object.keys(errors).length > 0 ? null : content,
  };
}
