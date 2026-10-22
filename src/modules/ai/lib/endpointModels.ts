import { formatAiError } from "./errors";
import { createProxyFetch } from "./proxyFetch";

// Local servers and custom endpoints are reached through the native proxy, as
// their chat requests are (no webview CORS, private networks allowed).
const endpointFetch = createProxyFetch({ allowPrivateNetwork: true });

/** The model ids an OpenAI-compatible server lists at `GET <base>/models`
 *  (LM Studio, Ollama, MLX, vLLM, gateways), sorted and without duplicates. */
export async function listEndpointModels(
  baseURL: string,
  apiKey?: string | null,
  fetchImpl: typeof fetch = endpointFetch,
): Promise<string[]> {
  const url = `${baseURL.trim().replace(/\/+$/, "")}/models`;
  const response = await fetchImpl(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${formatAiError(text)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("The server's model list is not JSON.");
  }
  return parseModelList(body);
}

export function parseModelList(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new Error("The server's model list is not in the OpenAI format.");
  }
  const ids = new Set<string>();
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}
