type ErrorDetails = {
  code: string | null;
  message: string;
};

const MAX_ERROR_LENGTH = 800;
const FALLBACK_ERROR =
  "The AI provider rejected the request. Check the selected model and provider settings, then try again.";

// What a webview's fetch rejects with when no readable response arrived
// (Chromium/WebView2, WebKit, Gecko). An error reply without CORS headers, as
// OpenAI sends for a bad key, is indistinguishable from a dropped connection.
const WEBVIEW_NETWORK_FAILURES: ReadonlySet<string> = new Set([
  "failed to fetch",
  "load failed",
  "networkerror when attempting to fetch resource.",
]);

export function formatAiError(error: unknown): string {
  const networkFailure = webviewNetworkFailure(error);
  if (networkFailure) {
    return `No readable reply from the AI provider (${networkFailure}). The network may be blocked, or the provider refused the request without letting the app read why, as it does for an invalid API key or an exhausted quota. Check your connection and the key in Settings → Models, then try again.`;
  }
  const details = extractErrorDetails(error);
  if (!details) return FALLBACK_ERROR;
  const message = sanitizeErrorMessage(details.message);
  if (!message) return FALLBACK_ERROR;
  const prefix = errorPrefix(details.code, message);
  return prefix ? `${prefix}: ${message}` : message;
}

function extractErrorDetails(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): ErrorDetails | null {
  if (depth > 5 || value == null || seen.has(value)) return null;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (parsed !== null) return extractErrorDetails(parsed, depth + 1, seen);
    return { code: null, message: value };
  }
  if (typeof value !== "object") return null;
  seen.add(value);

  const record = value as Record<string, unknown>;
  const code = stringValue(record.code);
  for (const key of ["error", "responseBody", "body", "data", "cause"]) {
    const nested = extractErrorDetails(record[key], depth + 1, seen);
    if (nested) return { code: nested.code ?? code, message: nested.message };
  }
  const message = stringValue(record.message);
  return message ? { code, message } : null;
}

function webviewNetworkFailure(error: unknown): string | null {
  for (
    let current = error, depth = 0;
    current instanceof Error && depth < 5;
    current = (current as { cause?: unknown }).cause, depth++
  ) {
    if (
      current instanceof TypeError &&
      WEBVIEW_NETWORK_FAILURES.has(current.message.trim().toLowerCase())
    ) {
      return current.message.trim();
    }
  }
  return null;
}

function parseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function sanitizeErrorMessage(message: string): string {
  const redacted = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:sk-(?:ant-|proj-)?|xai-|gsk_)[A-Za-z0-9_-]{8,}\b/g,
      "[redacted]",
    )
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= MAX_ERROR_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_ERROR_LENGTH - 3)}...`;
}

function errorPrefix(code: string | null, message: string): string | null {
  switch (code?.toLowerCase()) {
    case "model_not_found":
    case "not_found_error":
      return "Model unavailable";
    case "invalid_api_key":
    case "authentication_error":
      return "Authentication failed";
    case "insufficient_quota":
      return "Quota exceeded";
    case "rate_limit_exceeded":
    case "rate_limit_error":
      return "Rate limit reached";
  }
  return /\bmodel\b.*\b(?:limited preview|not available|not found)\b/i.test(
    message,
  )
    ? "Model unavailable"
    : null;
}
