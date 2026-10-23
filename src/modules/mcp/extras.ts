import { loadServers } from "./lib/configStore";
import { useMcpExtras } from "./lib/extrasCatalog";
import type { CompletionRef } from "./runtime";

export type { CompletionRef } from "./runtime";

/**
 * What the composer asks of the window's MCP servers: start them for its
 * `@` and `/` lists, read a resource, get a prompt, ask for completions.
 * Light like `index.ts`: the client loads only once a server is enabled.
 */

let runtime: Promise<typeof import("./runtime")> | null = null;

function loadRuntime(): Promise<typeof import("./runtime")> {
  runtime ??= import("./runtime").catch((error) => {
    runtime = null;
    throw error;
  });
  return runtime;
}

let preparing: Promise<void> | null = null;

/**
 * Starts the window's enabled servers when the composer first lists what
 * they offer (with none enabled it only reads the configuration). Never
 * fails: a server that does not start says why in Settings.
 */
export function ensureMcpExtras(): Promise<void> {
  preparing ??= (async () => {
    const { setStarting } = useMcpExtras.getState();
    try {
      const servers = await loadServers();
      if (!runtime && !servers.some((s) => s.enabled)) return;
      await (await loadRuntime()).prepareExtras(servers, () =>
        setStarting(true),
      );
    } catch (error) {
      console.warn("[mcp] servers unavailable for the composer", error);
    } finally {
      setStarting(false);
      preparing = null;
    }
  })();
  return preparing;
}

export async function readMcpResource(
  serverId: string,
  uri: string,
): Promise<unknown> {
  return (await loadRuntime()).extras().read(serverId, uri);
}

/** Fills in a resource template and reads what it names. */
export async function readMcpTemplate(
  serverId: string,
  uriTemplate: string,
  values: Record<string, string>,
): Promise<{ uri: string; result: unknown }> {
  const extras = (await loadRuntime()).extras();
  const uri = extras.expand(uriTemplate, values);
  return { uri, result: await extras.read(serverId, uri) };
}

export async function getMcpPrompt(
  serverId: string,
  name: string,
  args: Record<string, string>,
): Promise<unknown> {
  return (await loadRuntime()).extras().getPrompt(serverId, name, args);
}

export async function completeMcpArgument(
  serverId: string,
  ref: CompletionRef,
  argument: { name: string; value: string },
  context: Record<string, string>,
): Promise<string[]> {
  if (!runtime) return [];
  return (await runtime).extras().complete(serverId, ref, argument, context);
}
