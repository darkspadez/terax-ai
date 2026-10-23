/**
 * macOS privacy controls refuse with EPERM, "Operation not permitted" (Rust
 * adds "(os error 1)", git prints the bare text). A file's own permissions
 * give EACCES, "Permission denied", which this never matches.
 */
export function isOperationNotPermitted(error: unknown): boolean {
  const text = errorText(error);
  return /operation not permitted/i.test(text) || /\(os error 1\)/.test(text);
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}
