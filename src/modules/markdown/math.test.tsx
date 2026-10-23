import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";
import { loadMathPlugins, mayContainMath, useMathPlugins } from "./math";
import { KATEX_OPTIONS, mathPlugin } from "./mathPlugin";
import { previewRehypePlugins } from "./previewPipeline";

const plugins = { math: mathPlugin };

// As the preview renders: its own rehype chain, static mode.
const preview = (md: string) =>
  renderToStaticMarkup(
    <Streamdown
      mode="static"
      parseIncompleteMarkdown={false}
      rehypePlugins={previewRehypePlugins("/repo", "light")}
      plugins={plugins}
    >
      {md}
    </Streamdown>,
  );

// As the chat renders: Streamdown's own chain, streaming mode.
const chat = (md: string) =>
  renderToStaticMarkup(<Streamdown plugins={plugins}>{md}</Streamdown>);

describe("math rendering", () => {
  it("renders inline, display and fenced math in the preview and the chat", () => {
    for (const render of [preview, chat]) {
      expect(render("Inline $x^2$ here.")).toContain('<span class="katex">');
      expect(render("Inline $$x^2$$ here.")).toContain('<span class="katex">');
      expect(render("$$\nE=mc^2\n$$")).toContain('class="katex-display"');
      expect(render("```math\n\\int_0^1 x\\,dx\n```")).toContain(
        'class="katex-display"',
      );
    }
  });

  it("keeps formulas accessible as MathML with their TeX source", () => {
    const html = preview("$a+b$");
    expect(html).toContain("<math");
    expect(html).toContain('<annotation encoding="application/x-tex">a+b');
  });

  it("closes a display formula that is still streaming", () => {
    expect(chat("Text\n\n$$\nE=mc")).toContain('class="katex-display"');
  });

  it("leaves code alone", () => {
    expect(chat("`$x$` and\n\n```js\nconst a = `$x$`;\n```")).not.toContain(
      "katex",
    );
  });
});

describe("dollar signs that are prices", () => {
  it("stay text, as do spans with inner spaces or a digit after", () => {
    for (const md of [
      "It costs $5 and $10 in total.",
      "Between $ x $ and more",
      "A $x$5 token",
    ]) {
      for (const render of [preview, chat]) {
        const html = render(md);
        expect(html).not.toContain("katex");
        expect(html).toContain(md.slice(md.indexOf("$"), md.lastIndexOf("$")));
      }
    }
  });

  it("keep the Markdown between them", () => {
    const html = chat("I paid $5 for **lunch** and $10 for `dinner`.");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5 for ");
    expect(html).toContain('data-streamdown="strong">lunch</span>');
    expect(html).toMatch(/<code[^>]*>dinner<\/code>/);
    expect(html).toContain(" and $10 for ");
  });

  it("do not hide a real formula after them", () => {
    const html = preview("From $5 to $10 per $x$ unit");
    expect(html).toContain("$5 to $10 per");
    expect(html.match(/<span class="katex">/g)).toHaveLength(1);
    expect(html).toContain('<annotation encoding="application/x-tex">x<');
  });
});

describe("untrusted input", () => {
  it("renders no links or HTML from \\href, \\url and the \\html extensions", () => {
    expect(KATEX_OPTIONS.trust).toBe(false);
    const html = chat(
      "$\\href{https://example.com}{x}$ $\\url{https://example.com}$ " +
        "$\\htmlClass{evil}{x}$ $\\htmlId{evil}{x}$ " +
        "$\\htmlData{foo=bar}{x}$ $\\includegraphics{https://example.com/a.png}$",
    );
    // The TeX source stays only in the MathML annotation.
    expect(html).not.toMatch(/<a\b/);
    expect(html).not.toMatch(/\b(?:href|src)=/);
    expect(html).not.toContain("<img");
    expect(html).not.toContain('id="evil"');
    expect(html).not.toMatch(/class="[^"]*\bevil\b/);
    expect(html).not.toContain("data-foo");
    // Each command shows as an error in place of its output.
    for (const command of ["href", "url", "htmlClass", "htmlId", "htmlData"]) {
      expect(html).toContain(`color:var(--destructive)">\\${command}`);
    }
  });

  it("shows a formula that does not parse as an inline error", () => {
    const html = preview("Before $\\frac{1}{$ after");
    expect(html).toContain("Before ");
    expect(html).toContain(" after");
    expect(html).toMatch(
      /<span class="katex-error" title="ParseError: [^"]+" style="color:var\(--destructive\)">\\frac\{1\}\{<\/span>/,
    );
  });

  it("caps user sizes so a formula cannot stretch the page", () => {
    const html = chat("$\\rule{100000em}{1em}$");
    expect(html).toContain('style="border-right-width:50em;');
    expect(html).toContain('<mspace mathbackground="black" width="50em"');
  });

  it("stops runaway macro expansion with an error", () => {
    const html = chat("$\\def\\a{\\a\\a}\\a$");
    expect(html).toContain("katex-error");
    expect(html).toContain("Too many expansions");
  });
});

describe("mayContainMath", () => {
  it("finds two dollars or a math fence", () => {
    expect(mayContainMath("a $x$ b")).toBe(true);
    expect(mayContainMath("costs $5 and $10")).toBe(true);
    expect(mayContainMath("$$\nx\n$$")).toBe(true);
    expect(mayContainMath("```math\nx\n```")).toBe(true);
    expect(mayContainMath("~~~ math\nx\n~~~")).toBe(true);
  });

  it("skips text that cannot hold math", () => {
    expect(mayContainMath("")).toBe(false);
    expect(mayContainMath("costs $5")).toBe(false);
    expect(mayContainMath("```mathematica\nx\n```")).toBe(false);
    expect(mayContainMath("plain **text**")).toBe(false);
  });
});

describe("useMathPlugins", () => {
  function Probe({ text }: { text: string }) {
    return (
      <Streamdown mode="static" plugins={useMathPlugins(text)}>
        {text}
      </Streamdown>
    );
  }

  it("renders math once the renderer has loaded, and only for text with math", async () => {
    expect(renderToStaticMarkup(<Probe text="$x$" />)).not.toContain("katex");
    await loadMathPlugins();
    expect(renderToStaticMarkup(<Probe text="$x$" />)).toContain(
      '<span class="katex">',
    );
    // A single dollar never pulls the renderer in, loaded or not.
    expect(renderToStaticMarkup(<Probe text="costs $5" />)).toContain(
      "costs $5",
    );
  });
});
