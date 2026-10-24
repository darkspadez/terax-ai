import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it, vi } from "vitest";

// The real renderer needs a browser (Mermaid lays text out in the DOM); its
// configuration and output handling are tested in mermaidRender.test.ts.
vi.mock("./MermaidDiagram", () => ({
  MermaidDiagram: ({
    code,
    pending,
    failed,
  }: {
    code: string;
    pending: ReactNode;
    failed: (error: unknown) => ReactNode;
  }) => (
    <figure data-diagram={code}>
      {pending}
      {failed(new Error("Parse error on line 2"))}
    </figure>
  ),
}));

const { ChatStreamingProvider } = await import(
  "@/components/ai-elements/chat-code"
);
const { MarkdownCode } = await import("@/components/ai-elements/markdown-code");
const { previewRehypePlugins } = await import("./previewPipeline");
const { DiagramError } = await import("./MermaidViews");

const DIAGRAM = "```mermaid\nflowchart TD\n  A --> B\n```";
const components = { code: MarkdownCode };

// As the preview renders: its own rehype chain, static mode.
const preview = (md: string) =>
  renderToStaticMarkup(
    <Streamdown
      mode="static"
      parseIncompleteMarkdown={false}
      rehypePlugins={previewRehypePlugins("/repo", "light")}
      components={components}
    >
      {md}
    </Streamdown>,
  );

const chat = (md: string, streaming: boolean) =>
  renderToStaticMarkup(
    <ChatStreamingProvider value={streaming}>
      <Streamdown components={components}>{md}</Streamdown>
    </ChatStreamingProvider>,
  );

describe("mermaid blocks", () => {
  it("render as a diagram block, not as code", async () => {
    const pending = preview(DIAGRAM);
    expect(pending).toContain(">mermaid</span>");
    expect(pending).toContain("Rendering diagram…");
    expect(pending).not.toContain("flowchart TD");

    // The renderer loads on demand; once it has, the block hands it the
    // source.
    await import("./MermaidDiagram");
    await Promise.resolve();
    expect(preview(DIAGRAM)).toContain(
      'data-diagram="flowchart TD\n  A --&gt; B"',
    );
    expect(chat(DIAGRAM, false)).toContain('data-diagram="flowchart TD');
  });

  it("give the renderer the block's pending and error views", async () => {
    await import("./MermaidDiagram");
    const html = preview(DIAGRAM);
    expect(html).toContain("Rendering diagram…");
    expect(html).toContain(
      "Could not render this diagram: Parse error on line 2",
    );
    expect(html).toMatch(/<pre[^>]*>flowchart TD\n {2}A --&gt; B<\/pre>/);
  });

  it("wait for a streaming reply to finish, like other code", () => {
    const html = chat(DIAGRAM, true);
    expect(html).toContain("Generating mermaid…");
    expect(html).not.toContain("data-diagram");
  });

  it("leave other fences to the code renderer", () => {
    const html = preview("```js\nconst a = 1;\n```\n\n```Mermaid\nx\n```");
    expect(html).toContain("const a = 1;");
    expect(html).not.toContain("data-diagram");
    expect(html).not.toContain("Rendering diagram");
  });
});

describe("DiagramError", () => {
  it("shows the error, then the source", () => {
    const html = renderToStaticMarkup(
      <DiagramError
        message="Parse error on line 2"
        source={"graph TD\n A -->"}
      />,
    );
    expect(html).toContain(
      "Could not render this diagram: Parse error on line 2",
    );
    expect(html).toMatch(/<pre[^>]*>graph TD\n A --&gt;<\/pre>/);
    expect(html.indexOf("Parse error")).toBeLessThan(html.indexOf("<pre"));
  });
});
