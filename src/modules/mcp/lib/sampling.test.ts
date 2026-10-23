import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BASE64 } from "./results";
import {
  chooseSamplingModel,
  initialDraft,
  MAX_SAMPLING_TEXT,
  SAMPLING_MAX_TOKENS,
  samplingDraftProblem,
  samplingModelMessages,
  samplingRequestView,
  samplingResult,
  samplingUsageNote,
  stopReasonFor,
} from "./sampling";

const base = {
  messages: [{ role: "user", content: { type: "text", text: "Hi" } }],
  maxTokens: 100,
};

function view(params: Record<string, unknown>) {
  const out = samplingRequestView({ ...base, ...params });
  if ("refused" in out) throw new Error(out.refused);
  return out.view;
}

describe("samplingRequestView", () => {
  it("shows everything the server asks for", () => {
    expect(
      view({
        messages: [
          { role: "user", content: { type: "text", text: "Q" } },
          { role: "assistant", content: [{ type: "text", text: "A" }] },
          {
            role: "user",
            content: [
              { type: "text", text: "Look" },
              { type: "image", mimeType: "IMAGE/PNG", data: "AAAA" },
            ],
          },
        ],
        systemPrompt: "Be brief",
        maxTokens: 50_000,
        temperature: 0.2,
        stopSequences: ["END", "", 3],
        includeContext: "allServers",
        modelPreferences: {
          hints: [{ name: " claude " }, { name: "" }, {}],
          costPriority: 0.3,
          speedPriority: 2,
        },
      }),
    ).toEqual({
      messages: [
        { role: "user", text: "Q", images: [] },
        { role: "assistant", text: "A", images: [] },
        {
          role: "user",
          text: "Look",
          images: [{ mediaType: "image/png", data: "AAAA" }],
        },
      ],
      systemPrompt: "Be brief",
      maxTokens: 50_000,
      temperature: 0.2,
      stopSequences: ["END"],
      includeContext: "allServers",
      hints: ["claude"],
      priorities: { cost: 0.3, speed: null, intelligence: null },
    });
  });

  it("refuses what Oarlock cannot or will not run", () => {
    const refused = (params: Record<string, unknown>) => {
      const out = samplingRequestView({ ...base, ...params });
      return "refused" in out ? out.refused : null;
    };
    expect(refused({ tools: [] })).toBe(
      "Oarlock does not offer tools to sampling requests.",
    );
    expect(refused({ toolChoice: { mode: "auto" } })).not.toBeNull();
    expect(refused({ task: { ttl: 1 } })).not.toBeNull();
    expect(refused({ messages: [] })).toBe("The request has no messages.");
    expect(refused({ maxTokens: 0 })).not.toBeNull();
    expect(refused({ maxTokens: 1.5 })).not.toBeNull();
    expect(
      refused({
        messages: [
          {
            role: "user",
            content: { type: "audio", data: "", mimeType: "audio/wav" },
          },
        ],
      }),
    ).toBe("Oarlock cannot send audio to its models.");
    expect(
      refused({
        messages: [
          {
            role: "user",
            content: { type: "tool_result", toolUseId: "1", content: [] },
          },
        ],
      }),
    ).toBe("Oarlock cannot send content of type tool_result.");
    expect(
      refused({
        messages: [
          {
            role: "user",
            content: { type: "image", mimeType: "image/tiff", data: "AA" },
          },
        ],
      }),
    ).toBe("Oarlock cannot send an image of type image/tiff.");
    expect(
      refused({
        messages: [
          {
            role: "user",
            content: {
              type: "image",
              mimeType: "image/png",
              data: "A".repeat(MAX_IMAGE_BASE64 + 1),
            },
          },
        ],
      }),
    ).toBe("The request's images are over the size limit.");
    expect(
      refused({
        messages: [
          {
            role: "assistant",
            content: { type: "image", mimeType: "image/png", data: "AA" },
          },
        ],
      }),
    ).not.toBeNull();
    expect(refused({ systemPrompt: "a".repeat(MAX_SAMPLING_TEXT + 1) })).toBe(
      "The request's text is over the size limit.",
    );
  });

  it("treats includeContext other than none as none, and shows it", () => {
    expect(view({}).includeContext).toBe("none");
    expect(view({ includeContext: "thisServer" }).includeContext).toBe(
      "thisServer",
    );
    expect(view({ includeContext: "everything" }).includeContext).toBe("none");
  });
});

describe("the draft the user approves", () => {
  it("starts capped at the hard ceiling", () => {
    expect(initialDraft(view({ maxTokens: 999_999 })).maxTokens).toBe(
      SAMPLING_MAX_TOKENS,
    );
    expect(initialDraft(view({ maxTokens: 64 })).maxTokens).toBe(64);
  });

  it("cannot run past the ceiling or without a message", () => {
    const draft = initialDraft(view({}));
    expect(samplingDraftProblem(draft)).toBeNull();
    expect(
      samplingDraftProblem({ ...draft, maxTokens: SAMPLING_MAX_TOKENS + 1 }),
    ).toMatch(/^Max tokens must be/);
    expect(
      samplingDraftProblem({ ...draft, maxTokens: Number.NaN }),
    ).not.toBeNull();
    expect(
      samplingDraftProblem({
        ...draft,
        messages: [{ role: "user", text: "  ", images: [] }],
      }),
    ).toBe("There is no message left to send.");
  });
});

describe("samplingModelMessages", () => {
  it("gives the model the edited messages, images as files, empty ones dropped", () => {
    expect(
      samplingModelMessages([
        { role: "user", text: "", images: [] },
        {
          role: "user",
          text: "Look",
          images: [{ mediaType: "image/png", data: "AA" }],
        },
        { role: "assistant", text: "Ok", images: [] },
        { role: "assistant", text: " ", images: [] },
        {
          role: "user",
          text: "",
          images: [{ mediaType: "image/gif", data: "BB" }],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "AA" },
          },
        ],
      },
      { role: "assistant", content: "Ok" },
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/gif",
            data: { type: "data", data: "BB" },
          },
        ],
      },
    ]);
  });
});

describe("chooseSamplingModel", () => {
  const current = { id: "gpt-5.4-mini", label: "GPT-5.4 mini" };
  const usable = [
    current,
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-5", label: "Claude Haiku 5" },
  ];

  it("takes the first hint something matches, preferring the conversation's model", () => {
    expect(chooseSamplingModel(["gemini", "sonnet"], current, usable)).toEqual({
      model: usable[1],
      hint: "sonnet",
    });
    expect(chooseSamplingModel(["Claude"], current, usable).model.id).toBe(
      "claude-sonnet-5",
    );
    expect(chooseSamplingModel(["gpt", "claude"], current, usable)).toEqual({
      model: current,
      hint: "gpt",
    });
  });

  it("keeps the conversation's model when no hint matches", () => {
    expect(chooseSamplingModel(["llama"], current, usable)).toEqual({
      model: current,
      hint: null,
    });
    expect(chooseSamplingModel([], current, [])).toEqual({
      model: current,
      hint: null,
    });
  });
});

describe("the result", () => {
  it("maps the finish reason to the spec's stop reasons", () => {
    expect(stopReasonFor("stop")).toBe("endTurn");
    expect(stopReasonFor("length")).toBe("maxTokens");
    expect(stopReasonFor("content-filter")).toBe("content-filter");
    expect(stopReasonFor("")).toBe("endTurn");
    expect(samplingResult("Paris", "gpt-5.4-mini", "stop")).toEqual({
      role: "assistant",
      content: { type: "text", text: "Paris" },
      model: "gpt-5.4-mini",
      stopReason: "endTurn",
    });
  });
});

describe("samplingUsageNote", () => {
  const used = (input: number, output: number) => ({
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: 0,
  });

  it("says how many tokens the run used and whether the conversation counted them", () => {
    expect(samplingUsageNote(used(1200, 34), true)).toBe(
      "Used 1,234 tokens (1,200 in, 34 out), counted in this conversation's usage.",
    );
    expect(samplingUsageNote(used(1, 0), false)).toBe(
      "Used 1 token (1 in, 0 out).",
    );
  });

  it("says so when the provider reported none", () => {
    expect(samplingUsageNote(used(0, 0), true)).toBe(
      "The model reported no token usage.",
    );
  });
});
