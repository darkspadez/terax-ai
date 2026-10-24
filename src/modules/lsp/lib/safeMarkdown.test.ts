import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { installSafeMarkdown } from "./safeMarkdown";

function render(markdown: string): string {
  const target = new Marked();
  installSafeMarkdown(target);
  return target.parse(markdown, { async: false });
}

describe("installSafeMarkdown", () => {
  it("shows raw HTML in docs as text", () => {
    expect(render('<iframe src="https://example.com"></iframe>')).not.toContain(
      "<iframe",
    );
    expect(render('<iframe src="https://example.com"></iframe>')).toContain(
      "&lt;iframe",
    );
    const inline = render('See <img src=x onerror="alert(1)"> here');
    expect(inline).not.toContain("<img");
    expect(inline).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("opens web and mail links in the browser and drops other targets", () => {
    expect(render("[docs](https://docs.rs/x)")).toContain(
      '<a href="https://docs.rs/x" target="_blank" rel="noopener noreferrer">docs</a>',
    );
    expect(render("[mail](mailto:a@b.c)")).toContain('href="mailto:a@b.c"');
    for (const href of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "command:editor.action",
      "../relative",
    ]) {
      const html = render(`[label](${href})`);
      expect(html).not.toContain("<a");
      expect(html).toContain("label");
    }
  });

  it("shows images as their alt text and keeps code and formatting", () => {
    const html = render('![a "badge"](https://example.com/b.png)');
    expect(html).not.toContain("<img");
    expect(html).toContain("a &quot;badge&quot;");
    expect(render("`<b>` and **bold**")).toContain(
      "<code>&lt;b&gt;</code> and <strong>bold</strong>",
    );
    expect(render("```rust\nfn x<T>() {}\n```")).toContain(
      "fn x&lt;T&gt;() {}",
    );
  });

  it("installs once per instance", () => {
    const target = new Marked();
    installSafeMarkdown(target);
    installSafeMarkdown(target);
    expect(target.parse("[x](https://a.b)", { async: false })).toBe(
      '<p><a href="https://a.b" target="_blank" rel="noopener noreferrer">x</a></p>\n',
    );
  });
});

describe("the LSP client", () => {
  it("renders docs through the safe renderer of the shared marked", async () => {
    await import("./client");
    const { marked } = await import("marked");
    const html = marked.parse('<iframe src="https://example.com"></iframe>', {
      async: false,
    });
    expect(html).not.toContain("<iframe");
  });
});
