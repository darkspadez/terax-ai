import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as [string, Record<string, unknown>][]);
const backend = vi.hoisted(() => ({
  /** Real paths, as `fs_canonicalize` answers; a missing key is refused. */
  real: new Map<string, string>(),
  authorized: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    calls.push([command, args]);
    if (command === "fs_canonicalize") {
      const real = backend.real.get(args.path as string);
      if (!real) throw "path is outside the authorized folders";
      return real;
    }
    if (command === "fs_read_file") {
      return { kind: "text", content: `text of ${args.path}`, size: 10 };
    }
    return undefined;
  }),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  authorizationSettled: async () => undefined,
  authorizeFileFolder: async (path: string) => {
    backend.authorized.push(path);
    return true;
  },
}));

import {
  agentReadRefusal,
  attachableText,
  attachmentName,
  MAX_TEXT_ATTACHMENT_BYTES,
  readDroppedFile,
  readPickedFile,
} from "./pathAttachment";

beforeEach(() => {
  calls.length = 0;
  backend.real.clear();
  backend.authorized = [];
});

describe("attachableText", () => {
  it("attaches text up to the size every attachment is capped at", () => {
    const text = "x".repeat(MAX_TEXT_ATTACHMENT_BYTES);
    expect(
      attachableText({
        kind: "text",
        content: text,
        size: MAX_TEXT_ATTACHMENT_BYTES,
      }),
    ).toEqual({ ok: true, text, size: MAX_TEXT_ATTACHMENT_BYTES });
  });

  it("refuses binary and larger files", () => {
    expect(attachableText({ kind: "binary", size: 5 })).toEqual({
      ok: false,
      reason: "It is not a text file.",
    });
    expect(
      attachableText({
        kind: "text",
        content: "",
        size: MAX_TEXT_ATTACHMENT_BYTES + 1,
      }),
    ).toEqual({
      ok: false,
      reason: "It is 201 KB; a text attachment holds up to 200 KB.",
    });
    expect(
      attachableText({ kind: "toolarge", size: 20 * 1024 * 1024, limit: 1 }),
    ).toMatchObject({ ok: false });
  });
});

describe("attachmentName", () => {
  it("is the last segment with either separator", () => {
    expect(attachmentName("/repo/src/a.ts")).toBe("a.ts");
    expect(attachmentName("C:/repo/b.md")).toBe("b.md");
    expect(attachmentName("C:\\repo\\c.txt")).toBe("c.txt");
  });
});

describe("agentReadRefusal", () => {
  it("words the agent's refusal for the user", () => {
    expect(
      agentReadRefusal('Refused: ".env" matches a sensitive-file pattern.'),
    ).toBe(
      'The agent may not read it: ".env" matches a sensitive-file pattern.',
    );
    expect(
      agentReadRefusal("Refused: path is inside a protected directory (.ssh)."),
    ).toBe(
      "The agent may not read it: path is inside a protected directory (.ssh).",
    );
  });
});

// crynta/terax-ai#230: nothing dropped may bypass the AI's folder limits.
describe("readDroppedFile", () => {
  it("reads as the agent's tools do and authorizes nothing", async () => {
    backend.real.set("/repo/link.md", "/repo/notes.md");
    await expect(readDroppedFile("/repo/link.md")).resolves.toEqual({
      kind: "text",
      content: "text of /repo/notes.md",
      size: 10,
    });
    expect(calls).toEqual([
      [
        "fs_canonicalize",
        { path: "/repo/link.md", workspace: { kind: "local" }, origin: "ai" },
      ],
      [
        "fs_read_file",
        { path: "/repo/notes.md", workspace: { kind: "local" }, origin: "ai" },
      ],
    ]);
    expect(backend.authorized).toEqual([]);
  });

  it("refuses what the AI's folder limits refuse", async () => {
    await expect(readDroppedFile("/elsewhere/a.md")).rejects.toThrow(
      /^The agent may not read it: could not resolve \/elsewhere\/a\.md/,
    );
    expect(calls.map(([command]) => command)).toEqual(["fs_canonicalize"]);
    expect(backend.authorized).toEqual([]);
  });

  it("refuses secret paths, also behind a link", async () => {
    await expect(readDroppedFile("/repo/.env")).rejects.toThrow(
      "sensitive-file pattern",
    );
    expect(calls).toEqual([]);

    backend.real.set("/repo/key.txt", "/home/me/.ssh/id_ed25519");
    await expect(readDroppedFile("/repo/key.txt")).rejects.toThrow(
      "The agent may not read it",
    );
    expect(calls.map(([command]) => command)).toEqual(["fs_canonicalize"]);
  });
});

describe("readPickedFile", () => {
  it("authorizes the folder of a file the user picked, as opening it does", async () => {
    await expect(readPickedFile("/elsewhere/a.md")).resolves.toMatchObject({
      kind: "text",
    });
    expect(backend.authorized).toEqual(["/elsewhere/a.md"]);
    expect(calls).toEqual([
      [
        "fs_read_file",
        { path: "/elsewhere/a.md", workspace: { kind: "local" } },
      ],
    ]);
  });
});
