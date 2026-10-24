import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) =>
    `asset://localhost/${encodeURIComponent(path)}`,
  invoke: vi.fn(() => new Promise(() => {})),
}));

const { MessageResponse } = await import("@/components/ai-elements/message");
const { highlight } = await import("@/components/ai-elements/chat-code-lezer");
const { RenderedMarkdown } = await import("./RenderedMarkdown");

// The Markdown preview of a file, exactly as the pane renders it.
const preview = (md: string) =>
  renderToStaticMarkup(
    <RenderedMarkdown content={md} baseDir="/repo" colorScheme="light" />,
  );

// An AI chat reply, finished streaming.
const chat = (md: string) =>
  renderToStaticMarkup(<MessageResponse>{md}</MessageResponse>);

const RUN = 'aria-label="Run in active terminal"';
const COPY = 'aria-label="Copy code"';
const SHELLS = ["bash", "sh", "zsh", "shell", "console", "powershell", "cmd"];

describe("Run in terminal", () => {
  it("is offered on shell blocks of AI chat replies", () => {
    for (const lang of SHELLS) {
      const html = chat(`\`\`\`${lang}\nnpm install\n\`\`\``);
      expect(html, lang).toContain(RUN);
      expect(html, lang).toContain(COPY);
    }
  });

  it("is never offered by a file in the Markdown preview", () => {
    for (const lang of SHELLS) {
      const html = preview(`\`\`\`${lang}\nnpm install\n\`\`\``);
      expect(html, lang).not.toContain(RUN);
      expect(html, lang).not.toContain("Run in");
      expect(html, lang).toContain(COPY);
      expect(html, lang).toMatch(/<pre[^>]*>npm install<\/pre>/);
    }
  });
});

describe("preview code", () => {
  it("shows blocks in GitHub's box without a language label", () => {
    for (const md of [
      "```ts\nconst a = 1;\n  b();\n```",
      "```\nconst a = 1;\n  b();\n```",
      "Text\n\n    const a = 1;\n      b();",
    ]) {
      const html = preview(md);
      expect(html).toMatch(
        /<div class="markdown-code-block"><pre[^>]*>const a = 1;\n {2}b\(\);<\/pre><div class="markdown-code-copy">/,
      );
      expect(html).not.toContain("not-prose");
      expect(html).not.toContain(">ts</span>");
    }
  });

  it("keeps inline code a plain element", () => {
    expect(preview("Run `npm test` now.")).toContain(
      "<p>Run <code>npm test</code> now.</p>",
    );
  });

  it("keeps a raw <pre> and its whitespace", () => {
    expect(preview("<pre>a\n  b</pre>")).toContain("<pre>a\n  b</pre>");
    expect(preview("<pre><code>x\n  y</code></pre>")).toMatch(
      /<div class="markdown-code-block"><pre[^>]*>x\n {2}y<\/pre>/,
    );
  });

  it("still draws Mermaid blocks as diagrams", () => {
    const html = preview("```mermaid\nflowchart TD\n  A --> B\n```");
    expect(html).toContain("Rendering diagram");
    expect(html).not.toContain("markdown-code-block");
  });

  it("highlights shell blocks, which chat shows as command cards instead", async () => {
    for (const lang of ["bash", "sh", "zsh", "shell", "pwsh", "powershell"]) {
      const nodes = await highlight('echo "$HOME" # done', lang);
      const classes = (nodes ?? []).flatMap((n) =>
        n.kind === "text" ? [n.cls] : [],
      );
      expect(classes.join(" "), lang).toMatch(/tok-(string|comment)/);
    }
  });
});
