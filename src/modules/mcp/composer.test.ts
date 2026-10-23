import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgumentsFormRequest } from "./lib/argumentsForm";
import { type McpServerExtras, useMcpExtras } from "./lib/extrasCatalog";

const api = vi.hoisted(() => ({
  ensureMcpExtras: vi.fn(async () => {}),
  getMcpPrompt: vi.fn(),
  readMcpResource: vi.fn(),
  readMcpTemplate: vi.fn(),
  completeMcpArgument: vi.fn(async () => ["rust"]),
  encodeForSending: vi.fn(),
}));
vi.mock("./extras", () => api);
const toast = vi.hoisted(() => ({ error: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/modules/ai/lib/imageAttachment", async (original) => ({
  ...(await original<typeof import("@/modules/ai/lib/imageAttachment")>()),
  encodeForSending: api.encodeForSending,
}));

import {
  resourceFiles,
  runPromptCall,
  startPromptCall,
  templateForm,
} from "./composer";

function docs(overrides: Partial<McpServerExtras> = {}): McpServerExtras {
  return {
    serverId: "s1",
    serverName: "Docs",
    resources: [],
    templates: [],
    prompts: [
      { name: "greet", arguments: [] },
      {
        name: "review",
        description: "Reviews code",
        arguments: [
          { name: "language", title: "Language", required: true },
          { name: "style", required: false },
        ],
      },
    ],
    completions: true,
    ...overrides,
  };
}

const text = (t: string) => ({
  messages: [{ role: "user", content: { type: "text", text: t } }],
});

beforeEach(() => {
  useMcpExtras.getState().setServers([docs()]);
});
afterEach(() => {
  vi.clearAllMocks();
  useMcpExtras.getState().setServers([]);
});

describe("startPromptCall", () => {
  it("gets a prompt without arguments at once", async () => {
    api.getMcpPrompt.mockResolvedValue(text("Hello"));
    const showForm = vi.fn();
    const out = await startPromptCall("docs:greet", showForm);
    expect(showForm).not.toHaveBeenCalled();
    expect(api.getMcpPrompt).toHaveBeenCalledWith("s1", "greet", {});
    expect(out).toMatchObject({
      kind: "message",
      block: expect.stringContaining('<mcp-prompt server="Docs" name="greet">'),
      images: [],
    });
  });

  it("asks for arguments in the composer's form first", async () => {
    api.getMcpPrompt.mockResolvedValue(text("Review rust"));
    let form: ArgumentsFormRequest | null = null;
    const pending = startPromptCall("docs:review", (f) => {
      form = f;
    });
    await vi.waitFor(() => expect(form).not.toBeNull());
    const shown = form as unknown as ArgumentsFormRequest;
    expect(shown).toMatchObject({
      title: "/docs:review",
      serverName: "Docs",
      description: "Reviews code",
      submitLabel: "Send",
      fields: [
        { name: "language", label: "Language", required: true },
        { name: "style", label: "style", required: false },
      ],
    });
    await expect(shown.complete?.("language", "r", {})).resolves.toEqual([
      "rust",
    ]);
    expect(api.completeMcpArgument).toHaveBeenCalledWith(
      "s1",
      { type: "ref/prompt", name: "review" },
      { name: "language", value: "r" },
      {},
    );
    await shown.submit({ language: "rust", style: "" });
    expect(api.getMcpPrompt).toHaveBeenCalledWith("s1", "review", {
      language: "rust",
    });
    await expect(pending).resolves.toMatchObject({ kind: "message" });
  });

  it("keeps the form open with the error when the server fails", async () => {
    api.getMcpPrompt.mockRejectedValueOnce(new Error("boom"));
    let form: ArgumentsFormRequest | null = null;
    const pending = startPromptCall("docs:review", (f) => {
      form = f;
    });
    await vi.waitFor(() => expect(form).not.toBeNull());
    const shown = form as unknown as ArgumentsFormRequest;
    await expect(shown.submit({ language: "go" })).rejects.toThrow("boom");
    shown.cancel();
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
  });

  it("offers no suggestions when the server has no completions", async () => {
    useMcpExtras.getState().setServers([docs({ completions: false })]);
    let form: ArgumentsFormRequest | null = null;
    void startPromptCall("docs:review", (f) => {
      form = f;
    });
    await vi.waitFor(() => expect(form).not.toBeNull());
    expect((form as unknown as ArgumentsFormRequest).complete).toBeUndefined();
  });

  it("starts the servers before saying a prompt is missing", async () => {
    useMcpExtras.getState().setServers([]);
    api.ensureMcpExtras.mockImplementationOnce(async () => {
      useMcpExtras.getState().setServers([docs()]);
    });
    api.getMcpPrompt.mockResolvedValue(text("Hi"));
    await expect(startPromptCall("docs:greet", vi.fn())).resolves.toMatchObject(
      {
        kind: "message",
      },
    );
    await expect(startPromptCall("docs:nope", vi.fn())).resolves.toEqual({
      kind: "missing",
    });
  });

  it("refuses a prompt with nothing to send", async () => {
    api.getMcpPrompt.mockResolvedValue({ messages: [] });
    await expect(startPromptCall("docs:greet", vi.fn())).rejects.toThrow(
      "returned no messages",
    );
  });
});

describe("runPromptCall", () => {
  const call = (command: string, picked: boolean) => {
    const sent = { send: vi.fn(), sendAsWritten: vi.fn() };
    return {
      sent,
      done: runPromptCall({ command, picked, showForm: vi.fn(), ...sent }),
    };
  };

  it("sends the prompt's block and images, noting what was left out", async () => {
    api.getMcpPrompt.mockResolvedValue({
      messages: [
        { role: "user", content: { type: "text", text: "Hi" } },
        {
          role: "user",
          content: { type: "audio", data: "", mimeType: "audio/wav" },
        },
      ],
    });
    const { sent, done } = call("docs:greet", true);
    await done;
    expect(sent.send).toHaveBeenCalledWith(
      expect.stringContaining("<mcp-prompt"),
      [],
    );
    expect(toast.message).toHaveBeenCalledWith(
      "Part of the prompt was left out",
      { description: "Audio content was left out." },
    );
  });

  it("sends typed text as written when no server offers the prompt", async () => {
    const typed = call("docs:nope", false);
    await typed.done;
    expect(typed.sent.sendAsWritten).toHaveBeenCalled();
    const picked = call("docs:nope", true);
    await picked.done;
    expect(picked.sent.sendAsWritten).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "The prompt /docs:nope is not available",
    );
  });

  it("says why a prompt failed", async () => {
    api.getMcpPrompt.mockRejectedValue(new Error("server down"));
    const { sent, done } = call("docs:greet", true);
    await done;
    expect(sent.send).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Could not run /docs:greet", {
      description: "server down",
    });
  });
});

describe("resourceFiles", () => {
  it("attaches text as the server's, in its block", async () => {
    api.readMcpResource.mockResolvedValue({
      contents: [{ uri: "doc://a", mimeType: "text/plain", text: "Body" }],
    });
    const out = await resourceFiles("s1", "Docs", {
      uri: "doc://a",
      name: "A",
    });
    expect(out.refused).toEqual([]);
    expect(out.files).toEqual([
      {
        id: "mcp:s1:doc://a:A",
        name: "A",
        kind: "text",
        mediaType: "text/plain",
        text: "Body",
        size: 4,
        mcp: { server: "Docs", uri: "doc://a" },
        block: expect.stringContaining(
          'The user attached this resource from the MCP server "Docs".',
        ),
      },
    ]);
  });

  it("sends an image as it is, or encoded again like a pasted one", async () => {
    api.readMcpResource.mockResolvedValue({
      contents: [
        { uri: "img://a", mimeType: "image/png", blob: "AAAA" },
        { uri: "img://b", mimeType: "image/bmp", blob: "AAAA" },
        { uri: "img://c", mimeType: "image/tiff", blob: "AAAA" },
      ],
    });
    api.encodeForSending
      .mockResolvedValueOnce(
        new File([new Uint8Array([1, 2])], "b.png", { type: "image/png" }),
      )
      .mockResolvedValueOnce(null);
    const out = await resourceFiles("s1", "Docs", {
      uri: "img://",
      name: "Pics",
    });
    expect(out.files.map((f) => [f.name, f.kind, f.mediaType, f.url])).toEqual([
      ["a", "image", "image/png", "data:image/png;base64,AAAA"],
      ["b", "image", "image/png", "data:image/png;base64,AQI="],
    ]);
    expect(out.files[0].block).toContain(
      "(The resource is the image attached to this message.)",
    );
    expect(out.refused).toEqual([
      "c: the image could not be converted or made small enough.",
    ]);
  });
});

describe("templateForm", () => {
  const template = {
    uriTemplate: "users://{team}/{name}{?fields}",
    name: "user",
    title: "A user",
    variables: ["team", "name", "fields"],
    optional: ["fields"],
  };

  it("asks for the variables, then attaches what the filled-in template names", async () => {
    api.readMcpTemplate.mockResolvedValue({
      uri: "users://core/ann",
      result: { contents: [{ uri: "users://core/ann", text: "Ann" }] },
    });
    const attach = vi.fn();
    const form = templateForm(
      { serverId: "s1", serverName: "Docs", template },
      attach,
      vi.fn(),
    );
    expect(form.fields).toEqual([
      { name: "team", label: "team", required: true },
      { name: "name", label: "name", required: true },
      { name: "fields", label: "fields", required: false },
    ]);
    expect(form.submitLabel).toBe("Attach");
    await form.submit({ team: "core", name: "ann", fields: "" });
    expect(api.readMcpTemplate).toHaveBeenCalledWith(
      "s1",
      template.uriTemplate,
      { team: "core", name: "ann" },
    );
    expect(attach.mock.calls[0][0].files[0]).toMatchObject({
      name: "ann",
      text: "Ann",
      mcp: { server: "Docs", uri: "users://core/ann" },
    });
    await form.complete?.("name", "a", { team: "core" });
    expect(api.completeMcpArgument).toHaveBeenCalledWith(
      "s1",
      { type: "ref/resource", uri: template.uriTemplate },
      { name: "name", value: "a" },
      { team: "core" },
    );
  });

  it("fails in the form when nothing can be attached", async () => {
    api.readMcpTemplate.mockResolvedValue({
      uri: "users://core/x",
      result: {
        contents: [
          { uri: "users://core/x", blob: "AA", mimeType: "application/zip" },
        ],
      },
    });
    const attach = vi.fn();
    const form = templateForm(
      { serverId: "s1", serverName: "Docs", template },
      attach,
      vi.fn(),
    );
    await expect(form.submit({ team: "core", name: "x" })).rejects.toThrow(
      "binary content (application/zip) cannot be attached",
    );
    expect(attach).not.toHaveBeenCalled();
  });
});
