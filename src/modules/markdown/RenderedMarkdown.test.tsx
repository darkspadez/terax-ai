import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) =>
    `asset://localhost/${encodeURIComponent(path)}`,
  invoke: vi.fn(() => new Promise(() => {})),
}));

const { RenderedMarkdown } = await import("./RenderedMarkdown");
const { imageHeightStyle } = await import("./MarkdownImage");

// Exactly what the pane renders inside its .markdown-body.
const render = (md: string) =>
  renderToStaticMarkup(<RenderedMarkdown content={md} baseDir="/repo" />);

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.join(here, file), "utf8");

describe("RenderedMarkdown Streamdown configuration", () => {
  const streamdownJsx =
    source("RenderedMarkdown.tsx").match(
      /<Streamdown[\s\S]*?<\/Streamdown>/,
    )?.[0] ?? "";

  it("renders complete markdown files in static mode", () => {
    expect(streamdownJsx).toMatch(/mode="static"/);
  });

  it("does not run streaming incomplete-markdown repair for files", () => {
    expect(streamdownJsx).toMatch(/parseIncompleteMarkdown=\{false\}/);
    expect(render("**not closed")).toContain("**not closed");
  });
});

// GitHub's markup, which markdownPreview.css styles: none of Streamdown's
// chat styling, table toolbar or scroll box.
describe("GitHub markup", () => {
  it("renders tables as plain tables with their alignment", () => {
    const html = render(
      "| Left | Centre | Right | None |\n|:--|:-:|--:|---|\n| a | b | c | d |",
    );
    expect(html).toContain("<table><thead><tr>");
    expect(html).toContain('<th style="text-align:left">Left</th>');
    expect(html).toContain('<th style="text-align:center">Centre</th>');
    expect(html).toContain('<td style="text-align:right">c</td>');
    expect(html).toContain("<th>None</th>");
    expect(html).not.toContain("data-streamdown");
    expect(html).not.toContain("Copy table");
    expect(html).not.toContain("max-height");
  });

  it("renders raw HTML tables the same way", () => {
    expect(render("<table><tr><td>raw</td></tr></table>")).toContain(
      "<table><tbody><tr><td>raw</td></tr></tbody></table>",
    );
  });

  it("keeps a paragraph that only holds an image, with its alignment", () => {
    const html = render(
      '<p align="center"><img src="logo.png" width="96"></p>',
    );
    expect(html).toMatch(/<p align="center"><img [^>]*width="96"/);
    expect(render('<div align="center">\n\n# Name\n\n</div>')).toContain(
      '<div align="center">\n<h1 id="user-content-name">Name</h1>\n</div>',
    );
  });

  it("renders headings, quotes, rules and emphasis as plain elements", () => {
    const html = render(
      "## Usage\n\n> quoted\n\n---\n\n**bold** H<sub>2</sub>O x<sup>2</sup>",
    );
    expect(html).toContain('<h2 id="user-content-usage">Usage</h2>');
    expect(html).toContain("<blockquote>\n<p>quoted</p>\n</blockquote>");
    expect(html).toContain("<hr/>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<sub>2</sub>");
    expect(html).toContain("<sup>2</sup>");
  });

  it("renders lists and task lists as GitHub does", () => {
    const html = render("- a\n  1. one\n- [ ] todo\n- [x] done");
    expect(html).toContain('<ul class="contains-task-list">');
    expect(html).toContain("<li>a\n<ol>\n<li>one</li>\n</ol>\n</li>");
    expect(html).toContain(
      '<li class="task-list-item"><input type="checkbox" disabled=""/> todo</li>',
    );
    expect(html).toContain(
      '<li class="task-list-item"><input type="checkbox" disabled="" checked=""/> done</li>',
    );
    expect(render("3. three\n4. four")).toContain('<ol start="3">');
  });

  it("keeps the marks the stylesheet hangs footnotes, keys and disclosures on", () => {
    const html = render(
      "Press <kbd>Ctrl</kbd>.[^1]\n\n<details><summary>More</summary>\n\nHidden\n\n</details>\n\n[^1]: The note.",
    );
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toMatch(/<a [^>]*data-footnote-ref=""/);
    expect(html).toContain('<section class="footnotes" data-footnotes="">');
    expect(html).toContain("<details><summary>More</summary>");
  });

  it("leaves block spacing to the stylesheet", () => {
    const html = render("text");
    expect(html).toMatch(/^<div class="[^"]*\bspace-y-0\b/);
    expect(html).not.toContain("space-y-4");
    expect(html).not.toContain("node=");
  });
});

describe("frontmatter", () => {
  it("renders as one key/value row per entry", () => {
    const html = render("---\nname: demo\nname: again\n---\nBody\n");
    expect(html).toMatch(/^<table class="markdown-frontmatter"><tbody>/);
    expect(html.match(/<th scope="row"[^>]*>name<\/th>/g)).toHaveLength(2);
    expect(html).toMatch(/<td[^>]*>demo<\/td>/);
    expect(html).toContain("Body");
  });

  it("renders values as inert text", () => {
    const html = render("---\nname: <img src=x onerror=alert(1)>\n---\nBody\n");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("image height", () => {
  it("keeps a pixel height attribute as a style", () => {
    expect(render('<img src="logo.png" height="40">')).toContain(
      'style="height:40px"',
    );
    expect(imageHeightStyle(40)).toEqual({ height: "40px" });
    expect(imageHeightStyle(" 12.5 ")).toEqual({ height: "12.5px" });
    for (const value of [undefined, "", "50%", "auto", "4em", "1e3"]) {
      expect(imageHeightStyle(value)).toBeUndefined();
    }
  });
});

// The preview's sheet loads with the first Markdown tab and stays for the
// window's life: every rule must stay inside the document.
describe("markdownPreview.css", () => {
  it("only styles the rendered document", () => {
    const css = source("markdownPreview.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...css.matchAll(/(?:^|})\s*([^{}]+?)\s*\{/g)].flatMap(
      (m) => m[1].split(/,(?![^(]*\))/).map((s) => s.trim()),
    );
    expect(selectors.length).toBeGreaterThan(50);
    for (const selector of selectors) {
      expect(selector).toMatch(/^(?:\.dark )?\.markdown-body(?![\w-])/);
    }
    expect(css).not.toContain("@layer");
  });
});
