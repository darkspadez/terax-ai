import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Channel, invoke } from "@tauri-apps/api/core";

export type StdioLaunch = {
  serverId: string;
  command: string;
  args: string[];
  /** Plain values; secret ones are named in `secretEnv` and read natively. */
  env: Record<string, string>;
  secretEnv: string[];
  cwd: string | null;
  /** The terminal shell set in Settings, whose environment the server gets. */
  shell: string | null;
};

export type StdioExit = {
  code: number | null;
  signal: number | null;
  reason: string | null;
  stderrTail: string;
};

/** Why a server's process ended, in a line for its status. */
export function describeExit(exit: StdioExit): string {
  const how =
    exit.reason ??
    (exit.code !== null
      ? `Exited with code ${exit.code}`
      : exit.signal !== null
        ? `Ended by signal ${exit.signal}`
        : "Exited");
  const last = exit.stderrTail.trim().split("\n").pop()?.trim();
  return last ? `${how}: ${last}` : how;
}

/**
 * The MCP SDK's transport over the native stdio host (`mcp_spawn`,
 * `mcp_send`, `mcp_kill`): one process, newline-delimited JSON-RPC. Sends
 * go out one at a time, in order (separate IPC calls could overtake each
 * other).
 */
export class TauriStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private id: number | null = null;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  /** How the process ended, once it has. */
  exit: StdioExit | null = null;

  constructor(private readonly launch: StdioLaunch) {}

  async start(): Promise<void> {
    const decoder = new TextDecoder();
    const onMessage = new Channel<ArrayBuffer>();
    onMessage.onmessage = (buffer) => {
      if (this.closed) return;
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(
          JSON.parse(decoder.decode(buffer)),
        );
      } catch (error) {
        this.onerror?.(
          new Error(
            `The server sent a line that is not a valid MCP message: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      this.onmessage?.(message);
    };
    const onExit = new Channel<StdioExit>();
    onExit.onmessage = (exit) => {
      this.exit = exit;
      this.finish();
    };
    this.id = await invoke<number>("mcp_spawn", {
      serverId: this.launch.serverId,
      command: this.launch.command,
      args: this.launch.args,
      env: this.launch.env,
      secretEnv: this.launch.secretEnv,
      cwd: this.launch.cwd,
      shell: this.launch.shell,
      onMessage,
      onExit,
    });
    // It may have exited (or been closed) before the id arrived.
    if (this.closed) void invoke("mcp_kill", { id: this.id }).catch(() => {});
  }

  send(message: JSONRPCMessage): Promise<void> {
    const text = JSON.stringify(message);
    const sent = this.queue.then(() => {
      if (this.closed || this.id === null) {
        throw new Error("The MCP server is not running");
      }
      return invoke<void>("mcp_send", { id: this.id, message: text });
    });
    this.queue = sent.catch(() => {});
    return sent;
  }

  async close(): Promise<void> {
    if (this.id !== null && !this.closed) {
      void invoke("mcp_kill", { id: this.id }).catch(() => {});
    }
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
