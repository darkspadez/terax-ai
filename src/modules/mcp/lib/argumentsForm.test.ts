import { describe, expect, it } from "vitest";
import { filledArguments, missingArguments } from "./argumentsForm";

const fields = [
  { name: "code", label: "Code", required: true },
  { name: "style", label: "Style", required: false },
];

describe("prompt and template arguments", () => {
  it("requires required fields", () => {
    expect(missingArguments(fields, { code: "  ", style: "x" })).toEqual({
      code: "This is required.",
    });
    expect(missingArguments(fields, { code: "x" })).toEqual({});
  });

  it("sends only filled-in fields", () => {
    expect(filledArguments(fields, { code: "x", style: " " })).toEqual({
      code: "x",
    });
  });
});
