import { Channel, invoke } from "@tauri-apps/api/core";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const STREAM_BUFFER_BYTES = 64 * 1024;
// Mirrors net/stream.rs: native grants a 128 KiB byte window and 256 packets in
// flight. Acknowledging at half of either keeps the sender from ever stalling
// on a healthy consumer while a stream of tiny SSE chunks costs no per-chunk
// IPC. Unconsumed data stays within the buffer plus one window (192 KiB).
const ACK_BYTES = 64 * 1024;
const ACK_PACKETS = 128;
const decoder = new TextDecoder();

/** The native commands one kind of request goes through, and what its
 *  metadata carries besides the request itself. */
type Route = {
  label: string;
  stream: string;
  cancel: string;
  ack: string;
  metadataHeader: string;
  extra: Record<string, unknown>;
};

function aiRoute(allowPrivateNetwork: boolean): Route {
  return {
    label: "AI",
    stream: "ai_http_stream",
    cancel: "ai_http_cancel",
    ack: "ai_http_ack",
    metadataHeader: "x-oarlock-ai-request",
    extra: { allowPrivateNetwork },
  };
}

export function createProxyFetch(
  opts: { allowPrivateNetwork?: boolean } = {},
): typeof fetch {
  const route = aiRoute(opts.allowPrivateNetwork === true);
  return (input, init) => proxyFetchImpl(input, init, route);
}

export const proxyFetch: typeof fetch = (input, init) =>
  proxyFetchImpl(input, init, aiRoute(false));

/**
 * A fetch for one remote MCP server's session (`mcp_http_open`): the same
 * native transport, through the backend's MCP gate, which allows only that
 * server's origin and adds its configured headers.
 */
export function createMcpFetch(session: number): typeof fetch {
  const route: Route = {
    label: "MCP",
    stream: "mcp_http_stream",
    cancel: "mcp_http_cancel",
    ack: "mcp_http_ack",
    metadataHeader: "x-oarlock-mcp-request",
    extra: { session },
  };
  return (input, init) => proxyFetchImpl(input, init, route);
}

async function readBody(request: Request, label: string): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (request.signal.aborted) throw makeAbortError();
      const next = await reader.read();
      if (request.signal.aborted) throw makeAbortError();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        cancel();
        throw new Error(`${label} request body exceeds 64 MiB`);
      }
      chunks.push(next.value);
    }
  } finally {
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0];
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function proxyFetchImpl(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  route: Route,
): Promise<Response> {
  const { label } = route;
  const request = new Request(input, init);
  if (request.signal.aborted) throw makeAbortError();
  const body = await readBody(request, label);
  if (request.signal.aborted) throw makeAbortError();
  const requestId = Array.from(
    crypto.getRandomValues(new Uint32Array(4)),
    (word) => word.toString(16).padStart(8, "0"),
  ).join("");

  return new Promise<Response>((resolve, reject) => {
    let resolved = false;
    let closed = false;
    let cancelled = false;
    let received = 0;
    let acknowledged = 0;
    let packets = 0;
    let acknowledgedPackets = 0;
    let ackInFlight = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const channel = new Channel<ArrayBuffer>();
    const cancelNative = () =>
      invoke<void>(route.cancel, { requestId }).catch(() => {});
    const cleanup = () => {
      request.signal.removeEventListener("abort", onAbort);
      channel.onmessage = () => {};
    };
    const fail = (error: Error, cancel = true) => {
      if (closed) return;
      closed = true;
      cancelled = cancel;
      cleanup();
      controller.error(error);
      if (!resolved) reject(error);
      if (cancel) void cancelNative();
    };
    const onAbort = () => fail(makeAbortError());
    const acknowledge = () => {
      if (
        closed ||
        ackInFlight ||
        received <= acknowledged ||
        (controller.desiredSize ?? 0) <= 0 ||
        (received - acknowledged < ACK_BYTES &&
          packets - acknowledgedPackets < ACK_PACKETS)
      )
        return;
      const bytes = received;
      const count = packets;
      ackInFlight = true;
      void invoke(route.ack, { requestId, bytes }).then(
        () => {
          acknowledged = Math.max(acknowledged, bytes);
          acknowledgedPackets = Math.max(acknowledgedPackets, count);
          ackInFlight = false;
          acknowledge();
        },
        (error) => fail(asError(error)),
      );
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        pull() {
          acknowledge();
        },
        cancel() {
          if (closed) return;
          closed = true;
          cancelled = true;
          cleanup();
          return cancelNative();
        },
      },
      { highWaterMark: STREAM_BUFFER_BYTES, size: (chunk) => chunk.byteLength },
    );

    channel.onmessage = (buffer) => {
      if (closed) return;
      try {
        const packet = new Uint8Array(buffer);
        const bytes = packet.subarray(1);
        switch (packet[0]) {
          case 0: {
            if (resolved)
              throw new Error(`Duplicate ${label} response headers`);
            const metadata = JSON.parse(decoder.decode(bytes)) as {
              status: number;
              headers: Record<string, string>;
            };
            const empty =
              request.method === "HEAD" ||
              [204, 205, 304].includes(metadata.status);
            const response = new Response(empty ? null : stream, {
              status: metadata.status,
              headers: metadata.headers,
            });
            resolved = true;
            resolve(response);
            if (empty) {
              closed = true;
              cancelled = true;
              cleanup();
              controller.close();
              void cancelNative();
            }
            break;
          }
          case 1:
            if (
              !resolved ||
              bytes.length === 0 ||
              bytes.length > STREAM_BUFFER_BYTES
            )
              throw new Error(`Invalid ${label} stream chunk`);
            received += bytes.length;
            packets += 1;
            if (!Number.isSafeInteger(received))
              throw new Error(`${label} stream byte offset overflow`);
            if (
              STREAM_BUFFER_BYTES -
                (controller.desiredSize ?? 0) +
                bytes.length >
              STREAM_BUFFER_BYTES * 3
            )
              throw new Error(`${label} stream exceeded its consumer buffer`);
            controller.enqueue(bytes);
            acknowledge();
            break;
          case 2:
            if (!resolved)
              throw new Error(`${label} stream ended before response headers`);
            closed = true;
            cleanup();
            controller.close();
            break;
          case 3:
            fail(new Error(decoder.decode(bytes)), false);
            break;
          default:
            throw new Error(`Invalid ${label} stream packet`);
        }
      } catch (error) {
        fail(asError(error));
      }
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) {
      onAbort();
      return;
    }
    const metadata = JSON.stringify({
      requestId,
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...route.extra,
      onEvent: channel,
    }).replace(
      /[^\x20-\x7e]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    if (metadata.length > 64 * 1024) {
      fail(new Error(`${label} request metadata exceeds 64 KiB`));
      return;
    }
    void invoke(route.stream, body, {
      headers: { [route.metadataHeader]: metadata },
    }).then(
      () => {
        if (cancelled) void cancelNative();
      },
      (error) => fail(asError(error)),
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function makeAbortError(): DOMException {
  return new DOMException("Request aborted", "AbortError");
}
