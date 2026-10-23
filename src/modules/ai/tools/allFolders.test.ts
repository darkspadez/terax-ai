import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

// "Allow AI tools to access all folders" on: the backend lets the AI tools'
// calls reach every folder, so these mocks answer for any path. Only the
// secret-path deny-list (the real one) stands between the agent and a file.
const links = vi.hoisted(() => new Map<string, string>());
const nativeMock = vi.hoisted(() => ({
  canonicalize: vi.fn(async (path: string) => links.get(path) ?? path),
  readFile: vi.fn(async () => ({ kind: "text", content: "x\n", size: 2 })),
  writeFile: vi.fn(async () => undefined),
  readDir: vi.fn(async () => []),
  createDir: vi.fn(async () => undefined),
  grep: vi.fn(async () => ({ hits: [], truncated: false, files_scanned: 0 })),
  glob: vi.fn(async () => ({ hits: [], truncated: false })),
}));

vi.mock("../lib/native", () => ({ native: nativeMock }));
vi.mock("../store/planStore", () => ({
  newQueuedEditId: () => "queued-id",
  usePlanStore: { getState: () => ({ active: false, enqueue: vi.fn() }) },
}));

import { buildEditTools } from "./edit";
import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";

const toolOptions: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "tool-call",
  messages: [],
  context: {},
};

const ctx = {
  getCwd: () => "/srv/elsewhere",
  getWorkspaceRoot: () => null,
  readCache: new Map<string, { size: number; hash: number }>(),
  getSessionId: () => "session",
} as unknown as ToolContext;

type AnyTool = {
  execute?: (input: never, options: typeof toolOptions) => unknown;
};

async function run(
  tool: AnyTool,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!tool.execute) throw new Error("tool has no execute");
  return (await tool.execute(input as never, toolOptions)) as Record<
    string,
    unknown
  >;
}

const fs = buildFsTools(ctx);
const search = buildSearchTools(ctx);
const edit = buildEditTools(ctx);

const reachesDisk = () =>
  nativeMock.readFile.mock.calls.length +
  nativeMock.writeFile.mock.calls.length +
  nativeMock.readDir.mock.calls.length +
  nativeMock.createDir.mock.calls.length +
  nativeMock.grep.mock.calls.length +
  nativeMock.glob.mock.calls.length;

beforeEach(() => {
  links.clear();
  for (const mock of Object.values(nativeMock)) mock.mockClear();
});

describe("with access to all folders, the AI tools still refuse secrets", () => {
  it.each([
    "/home/me/.ssh/id_ed25519",
    "/home/me/.aws/credentials",
    "/srv/app/.env",
    "/srv/app/.env.production",
    "/etc/shadow",
    "/opt/certs/server.key",
    "C:\\Users\\me\\.ssh\\id_rsa",
  ])("read_file %s", async (path) => {
    const result = await run(fs.read_file, { path });
    expect(String(result.error)).toMatch(/^Refused/);
    expect(reachesDisk()).toBe(0);
  });

  it.each([
    ["list_directory", fs.list_directory, { path: "/home/me/.gnupg" }],
    ["grep", search.grep, { pattern: "key", root: "/home/me/.ssh" }],
    ["glob", search.glob, { pattern: "**/*", root: "/home/me/.kube" }],
  ] as const)("%s in a protected folder", async (_name, tool, input) => {
    const result = await run(tool, input);
    expect(String(result.error)).toMatch(/^Refused/);
    expect(reachesDisk()).toBe(0);
  });

  it.each([
    ["write_file", fs.write_file, { path: "/etc/hosts", content: "x" }],
    ["write_file", fs.write_file, { path: "/home/me/.zshrc", content: "x" }],
    ["write_file", fs.write_file, { path: "/usr/bin/ls", content: "x" }],
    ["create_directory", fs.create_directory, { path: "/home/me/.ssh/x" }],
    [
      "edit",
      edit.edit,
      { path: "/srv/app/.env", old_string: "a", new_string: "b" },
    ],
  ] as const)("%s %o", async (_name, tool, input) => {
    const result = await run(tool, input);
    expect(String(result.error)).toMatch(/^Refused/);
    expect(reachesDisk()).toBe(0);
  });

  it("refuses an innocent name that leads into a protected folder", async () => {
    links.set("/tmp/notes.txt", "/home/me/.ssh/id_ed25519");
    const result = await run(fs.read_file, { path: "/tmp/notes.txt" });
    expect(String(result.error)).toMatch(/^Refused/);
    expect(reachesDisk()).toBe(0);
  });

  it("reads and writes ordinary files anywhere", async () => {
    const read = await run(fs.read_file, { path: "/srv/data/notes.txt" });
    expect(read.error).toBeUndefined();
    expect(nativeMock.readFile).toHaveBeenCalledWith("/srv/data/notes.txt");

    const written = await run(fs.write_file, {
      path: "/srv/data/out.txt",
      content: "y",
    });
    expect(written.error).toBeUndefined();
    expect(nativeMock.writeFile).toHaveBeenCalledWith("/srv/data/out.txt", "y");
  });
});
