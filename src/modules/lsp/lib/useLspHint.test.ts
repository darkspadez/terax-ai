import { describe, expect, it } from "vitest";
import { LSP_PRESETS } from "./presets";
import { lspHint } from "./useLspHint";

const preset = LSP_PRESETS[0];
const base = {
  preset,
  local: true,
  activation: "enabled" as const,
  detected: "/usr/bin/typescript-language-server",
  root: "/repo" as string | null | undefined,
  sessions: [] as {
    presetId: string;
    root: string;
    status: "starting" | "running" | "error";
  }[],
  failure: undefined as string | undefined,
};

describe("lspHint", () => {
  it("shows the session of the file's own project", () => {
    expect(
      lspHint({
        ...base,
        sessions: [
          { presetId: preset.id, root: "/other", status: "running" },
          { presetId: preset.id, root: "/repo", status: "starting" },
        ],
      }),
    ).toEqual({ kind: "active", preset, status: "starting" });
  });

  // crynta/terax-ai#1039: the pill used to vanish without a word.
  it("explains a file outside any project", () => {
    expect(
      lspHint({
        ...base,
        root: null,
        sessions: [{ presetId: preset.id, root: "/other", status: "running" }],
      }),
    ).toEqual({ kind: "no-root", preset });
  });

  it("offers the install steps when an enabled server's binary is missing", () => {
    expect(lspHint({ ...base, detected: null })).toEqual({
      kind: "install",
      preset,
    });
  });

  it("reports a server that was given up on", () => {
    expect(lspHint({ ...base, failure: "crashed 3 times" })).toEqual({
      kind: "error",
      preset,
      reason: "crashed 3 times",
    });
  });

  it("waits while the root or the session is still unknown", () => {
    expect(lspHint({ ...base, root: undefined })).toBeNull();
    expect(lspHint(base)).toBeNull();
  });

  it("offers to enable or install a server that is not enabled yet", () => {
    expect(lspHint({ ...base, activation: undefined })).toEqual({
      kind: "enable",
      preset,
    });
    expect(lspHint({ ...base, activation: undefined, detected: null })).toEqual(
      { kind: "install", preset },
    );
    expect(
      lspHint({ ...base, activation: undefined, detected: undefined }),
    ).toBeNull();
  });

  it("stays out of the way when dismissed, remote or unsupported", () => {
    expect(lspHint({ ...base, activation: "dismissed" })).toBeNull();
    expect(lspHint({ ...base, local: false })).toBeNull();
    expect(lspHint({ ...base, preset: null })).toBeNull();
  });
});
