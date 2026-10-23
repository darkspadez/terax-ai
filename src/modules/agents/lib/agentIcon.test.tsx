import {
  AiBrowserIcon,
  ClaudeIcon,
  GoogleIcon,
} from "@hugeicons/core-free-icons";
import { describe, expect, it } from "vitest";
import { agentMark } from "./agentIcon";

describe("agentMark", () => {
  it("draws known agents with their own mark", () => {
    expect(agentMark("claude")).toBe(ClaudeIcon);
    expect(agentMark("Claude")).toBe(ClaudeIcon);
    expect(agentMark("antigravity")).toBe(GoogleIcon);
    expect(agentMark("pi")).toBe("pi");
    expect(agentMark("Oarlock")).toBe("oarlock");
  });

  it("draws any other name with the generic mark", () => {
    for (const name of ["my-agent", "gjc", "claude-phish", "oarlock-evil", ""]) {
      expect(agentMark(name)).toBe(AiBrowserIcon);
    }
    // Inherited properties are not known agents either.
    expect(agentMark("constructor")).toBe(AiBrowserIcon);
    expect(agentMark("__proto__")).toBe(AiBrowserIcon);
  });
});
