import { createMcpFetch } from "@/modules/ai/lib/proxyFetch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { SignInRequiredError, watchUnauthorized } from "../lib/auth";
import {
  isProjectServer,
  type McpServerConfig,
  splitValues,
} from "../lib/config";
import { AjvJsonSchemaValidator as PassThroughValidator } from "./ajvProvider";
import { describeExit, TauriStdioTransport } from "./stdioTransport";

/** The initialize handshake; a slow `npx` download counts toward it. */
const CONNECT_TIMEOUT_MS = 60_000;

export type Connection = {
  client: Client;
  /** Why the connection ended, once it has (a process exit). */
  endReason: () => string | null;
  /** The server refused it for lack of sign-in (after the backend tried a refresh). */
  signInRequired: () => boolean;
  /** Ends the session and frees what the backend holds for it. */
  close: () => Promise<void>;
  remote: boolean;
};

let clientVersion: Promise<string> | null = null;

function terax(): Promise<string> {
  clientVersion ??= getVersion().catch(() => "0.0.0");
  return clientVersion;
}

/**
 * A connected MCP client for `server`: the transport (the native stdio host,
 * or HTTP through the backend's MCP gate), then the initialize handshake.
 * Terax offers no client capabilities yet (sampling, elicitation and roots
 * come later), so a server cannot call back into it.
 */
export async function connectServer(
  server: McpServerConfig,
  shell: string | null,
): Promise<Connection> {
  const client = new Client(
    { name: "Terax", version: await terax() },
    { capabilities: {}, jsonSchemaValidator: new PassThroughValidator() },
  );
  const t = server.transport;
  const project = isProjectServer(server);
  let transport: Transport;
  let endReason: () => string | null = () => null;
  let release = async () => {};
  let unauthorized = false;
  if (t.type === "stdio") {
    const { plain, secret } = splitValues(t.env);
    const stdio = new TauriStdioTransport({
      serverId: server.id,
      command: t.command,
      args: t.args,
      env: plain,
      secretEnv: secret,
      cwd: t.cwd,
      shell,
      project,
    });
    transport = stdio;
    endReason = () => (stdio.exit ? describeExit(stdio.exit) : null);
  } else {
    const { plain, secret } = splitValues(t.headers);
    // A project server's URL and headers are expanded by the backend.
    const { id: session, url: opened } = project
      ? await invoke<{ id: number; url: string }>("mcp_project_http_open", {
          serverId: server.id,
          shell,
        })
      : {
          id: await invoke<number>("mcp_http_open", {
            serverId: server.id,
            url: t.url,
            headers: plain,
            secretHeaders: secret,
          }),
          url: t.url,
        };
    release = () => invoke<void>("mcp_http_close", { id: session });
    const fetch = watchUnauthorized(createMcpFetch(session), () => {
      unauthorized = true;
    });
    const url = new URL(opened);
    transport =
      t.type === "http"
        ? new StreamableHTTPClientTransport(url, { fetch })
        : new SSEClientTransport(url, { fetch });
  }
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => {});
    await release().catch(() => {});
    if (unauthorized) throw new SignInRequiredError();
    const reason = endReason();
    throw reason ? new Error(reason) : error;
  }
  return {
    client,
    endReason,
    signInRequired: () => unauthorized,
    remote: t.type !== "stdio",
    close: async () => {
      if (transport instanceof StreamableHTTPClientTransport) {
        await withTimeout(transport.terminateSession(), 2000).catch(() => {});
      }
      await client.close().catch(() => {});
      await release().catch(() => {});
    },
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), ms),
    ),
  ]);
}
