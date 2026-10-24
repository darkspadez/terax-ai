import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";

import { codeBlockLanguage, MarkdownCode, markdownCodeText } from "./markdown-code";

describe("markdownCodeText", () => {
  it("preserves text nested inside React children for HTML-wrapped code blocks", async () => {
    const React = await import("react");

    const text = markdownCodeText([
      "\n",
      React.createElement("span", { key: "a" }, 'const client = createClient("");'),
      "\n",
      React.createElement("span", { key: "b" }, 'await client.send({ id: "example" });'),
      "\n",
    ]);

    expect(text).toBe(
      '\nconst client = createClient("");\nawait client.send({ id: "example" });\n',
    );
  });
});

describe("codeBlockLanguage", () => {
  it("tells blocks from inline code by Streamdown's block mark", () => {
    expect(codeBlockLanguage("language-ts", { "data-block": "true" })).toBe("ts");
    expect(codeBlockLanguage(undefined, { "data-block": "true" })).toBe("");
    expect(codeBlockLanguage(undefined, {})).toBeNull();
    // Raw HTML may put a language class on inline code; it stays inline.
    expect(codeBlockLanguage("language-ts", {})).toBeNull();
  });

  it("keeps the whole info word", () => {
    expect(codeBlockLanguage("language-c++", { "data-block": "true" })).toBe("c++");
    expect(codeBlockLanguage("language-objective-c", { "data-block": "true" })).toBe(
      "objective-c",
    );
  });
});

// As AI chat replies render: Streamdown's own chain, streaming mode.
const chat = (md: string) =>
  renderToStaticMarkup(<Streamdown components={{ code: MarkdownCode }}>{md}</Streamdown>);

describe("MarkdownCode", () => {
  it("renders fences without a language and indented code as blocks", () => {
    for (const md of ["```\nline 1\n  line 2\n```", "Text\n\n    line 1\n      line 2"]) {
      const html = chat(md);
      expect(html).toContain("<pre");
      expect(html).toContain("line 1\n  line 2");
      expect(html).toContain(">text</span>");
      expect(html).not.toContain("data-block");
    }
  });

  it("keeps inline code inline without leaking the AST node", () => {
    const html = chat("Use `npm test` here.");
    expect(html).toMatch(/<code class="[^"]*">npm test<\/code>/);
    expect(html).not.toContain("node=");
    expect(html).not.toContain("<pre");
  });

  it("labels a block with its whole language word", () => {
    expect(chat("```c++\nint x;\n```")).toContain(">c++</span>");
  });
});
