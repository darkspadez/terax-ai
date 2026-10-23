import { describe, expect, it } from "vitest";
import {
  cleanPrompts,
  cleanResources,
  cleanTemplates,
  MAX_RESOURCES,
  MAX_URI_LENGTH,
  optionalVariables,
} from "./extrasCatalog";

describe("cleanResources", () => {
  it("keeps addressable resources once, with display text made safe", () => {
    const out = cleanResources([
      {
        uri: "file:///a.txt",
        name: "a\u202E.txt",
        title: "A",
        description: "First\nline",
        mimeType: "Text/Plain",
      },
      { uri: "file:///a.txt", name: "again" },
      { uri: "x://\u0000bad", name: "control in the address" },
      { uri: `x://${"a".repeat(MAX_URI_LENGTH)}`, name: "too long to name" },
      { name: "no uri" },
      "junk",
      { uri: "mem://b", mimeType: "not a type" },
    ]);
    expect(out).toEqual([
      {
        uri: "file:///a.txt",
        name: "a.txt",
        title: "A",
        description: "First\nline",
        mimeType: "text/plain",
      },
      {
        uri: "mem://b",
        name: "mem://b",
        title: undefined,
        description: undefined,
        mimeType: undefined,
      },
    ]);
  });

  it("caps how many it keeps", () => {
    const many = Array.from({ length: MAX_RESOURCES + 5 }, (_, i) => ({
      uri: `r://${i}`,
      name: `r${i}`,
    }));
    expect(cleanResources(many)).toHaveLength(MAX_RESOURCES);
  });
});

describe("cleanTemplates", () => {
  const vars = (t: string) =>
    [...t.matchAll(/\{[?&]?([^}]+)\}/g)].flatMap((m) => m[1].split(","));

  it("keeps parseable templates with their variables and which may stay empty", () => {
    expect(
      cleanTemplates(
        [
          { uriTemplate: "repo://{owner}/{name}{?ref}", name: "Repo" },
          { uriTemplate: "bad://{", name: "Broken" },
        ],
        (t) => (t.includes("{") && !t.endsWith("{") ? vars(t) : null),
      ),
    ).toEqual([
      {
        uriTemplate: "repo://{owner}/{name}{?ref}",
        name: "Repo",
        title: undefined,
        description: undefined,
        mimeType: undefined,
        variables: ["owner", "name", "ref"],
        optional: ["ref"],
      },
    ]);
  });

  it("drops a template whose parser throws", () => {
    expect(
      cleanTemplates([{ uriTemplate: "x://{a}", name: "x" }], () => {
        throw new Error("bad");
      }),
    ).toEqual([]);
  });
});

describe("optionalVariables", () => {
  it("names the variables of query expansions", () => {
    expect(optionalVariables("a://{x}{?y,z*}{&w:3}{#f}")).toEqual([
      "y",
      "z",
      "w",
    ]);
  });
});

describe("cleanPrompts", () => {
  it("keeps prompts with well-formed arguments", () => {
    expect(
      cleanPrompts([
        {
          name: "review",
          description: "Reviews code",
          arguments: [
            { name: "code", required: true },
            { name: "style", title: "Style" },
          ],
        },
        { name: "dupe-args", arguments: [{ name: "a" }, { name: "a" }] },
        { name: "review" },
        { name: "plain" },
      ]),
    ).toEqual([
      {
        name: "review",
        title: undefined,
        description: "Reviews code",
        arguments: [
          {
            name: "code",
            title: undefined,
            description: undefined,
            required: true,
          },
          {
            name: "style",
            title: "Style",
            description: undefined,
            required: false,
          },
        ],
      },
      {
        name: "plain",
        title: undefined,
        description: undefined,
        arguments: [],
      },
    ]);
  });
});
