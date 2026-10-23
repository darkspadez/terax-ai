import { describe, expect, it } from "vitest";
import { parseMcpPromptInvocation } from "./slash";

describe("parseMcpPromptInvocation", () => {
  it("reads /server:prompt and the text after it", () => {
    expect(parseMcpPromptInvocation("/Git:Review_PR  please\nnow ")).toEqual({
      command: "git:review_pr",
      text: "please\nnow",
    });
    expect(parseMcpPromptInvocation("/a.b:c-d")).toEqual({
      command: "a.b:c-d",
      text: "",
    });
  });

  it("is not a skill call, a command or plain text", () => {
    expect(parseMcpPromptInvocation("/review now")).toBeNull();
    expect(parseMcpPromptInvocation("look at /a:b")).toBeNull();
    expect(parseMcpPromptInvocation("/a:")).toBeNull();
  });
});
