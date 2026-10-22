// Local HTTP endpoints for the harnesses (Node's http module): a loopback listener on a free port,
// request bodies, CORS headers and a static file server for a build directory.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, posix } from "node:path";

export type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

export type Listening = { port: number; url: string; close(): void };

/** Serves `handler` on 127.0.0.1 on a free port. Requests never time out (the labs hold them). */
export function listen(handler: Handler): Promise<Listening> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({
        port,
        url: `http://127.0.0.1:${port}`,
        close() {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The request path without query or fragment. */
export function pathOf(request: IncomingMessage): string {
  return (request.url ?? "/").split("#")[0].split("?")[0];
}

export function cors(response: ServerResponse, headers = false): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (headers) response.setHeader("Access-Control-Allow-Headers", "*");
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ico": "image/vnd.microsoft.icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serves the files under `directory` for GET and HEAD, like Python's SimpleHTTPRequestHandler:
 * `..` never leaves the directory, a directory path redirects to its slash form and serves its
 * index.html, anything else missing is a 404.
 */
export function staticFiles(directory: string): Handler {
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(501, { "Content-Length": "0" });
      response.end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(pathOf(request));
    } catch {
      path = pathOf(request);
    }
    const words = posix
      .normalize(path)
      .split("/")
      .filter((word) => word && word !== "." && word !== "..");
    let file = join(directory, ...words);
    let info = await stat(file).catch(() => undefined);
    if (info?.isDirectory()) {
      if (!path.endsWith("/")) {
        const query = (request.url ?? "").slice(pathOf(request).length);
        response.writeHead(301, {
          Location: `${pathOf(request)}/${query}`,
          "Content-Length": "0",
        });
        response.end();
        return;
      }
      file = join(file, "index.html");
      info = await stat(file).catch(() => undefined);
    }
    if (!info?.isFile()) {
      response.writeHead(404, { "Content-Length": "0" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type":
        CONTENT_TYPES[extname(file).toLowerCase()] ??
        "application/octet-stream",
      "Content-Length": String(info.size),
      "Last-Modified": info.mtime.toUTCString(),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file)
      .on("error", () => response.destroy())
      .pipe(response);
  };
}
