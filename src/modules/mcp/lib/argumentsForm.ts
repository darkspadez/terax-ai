/**
 * The composer's small form for what an MCP prompt or resource template
 * needs: its arguments, with the server's suggestions when it offers
 * completions. The composer holds the open form; the MCP side builds it.
 * Pure.
 */

export type ArgumentField = {
  name: string;
  label: string;
  description?: string;
  required: boolean;
};

export type ArgumentsFormRequest = {
  /** Changes for every form, so a new one starts empty. */
  id: string;
  /** What runs: `/server:prompt`, or the template's name. */
  title: string;
  serverName: string;
  description?: string;
  fields: ArgumentField[];
  submitLabel: string;
  /** The server's suggestions for a field; absent when it offers none. */
  complete?: (
    field: string,
    value: string,
    values: Record<string, string>,
  ) => Promise<string[]>;
  /** Runs it; a thrown error is shown in the form, which stays open. */
  submit: (values: Record<string, string>) => Promise<void>;
  cancel: () => void;
};

/** A message per required field left empty. */
export function missingArguments(
  fields: readonly ArgumentField[],
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.required && !(values[field.name] ?? "").trim()) {
      errors[field.name] = "This is required.";
    }
  }
  return errors;
}

/** The arguments to send: filled-in fields only. */
export function filledArguments(
  fields: readonly ArgumentField[],
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name] ?? "";
    if (value.trim()) out[field.name] = value;
  }
  return out;
}
