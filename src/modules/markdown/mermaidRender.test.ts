import { describe, expect, it } from "vitest";
import {
  DiagramCache,
  MERMAID_SECURE_KEYS,
  mermaidConfig,
  serialized,
  stripSvgLinks,
} from "./mermaidRender";
import { diagramError } from "./MermaidViews";

describe("mermaidConfig", () => {
  it("renders untrusted diagrams strictly, as SVG text, without drawing errors", () => {
    for (const mode of ["light", "dark"] as const) {
      const config = mermaidConfig(mode);
      expect(config.securityLevel).toBe("strict");
      expect(config.htmlLabels).toBe(false);
      expect(config.flowchart?.htmlLabels).toBe(false);
      expect(config.startOnLoad).toBe(false);
      expect(config.suppressErrorRendering).toBe(true);
      expect(config.secure).toBe(MERMAID_SECURE_KEYS);
      expect(config.themeCSS).toBeUndefined();
      expect(config.dompurifyConfig).toBeUndefined();
    }
  });

  it("follows the app's light or dark theme in the app's font", () => {
    expect(mermaidConfig("light").theme).toBe("default");
    expect(mermaidConfig("dark").theme).toBe("dark");
    expect(mermaidConfig("dark").fontFamily).toBe(
      mermaidConfig("light").fontFamily,
    );
    expect(mermaidConfig("light").fontFamily).toContain("Inter Variable");
  });

  it("keeps Mermaid's secure keys and locks labels, sanitizer and CSS against directives", () => {
    expect(MERMAID_SECURE_KEYS).toEqual(
      expect.arrayContaining([
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
        "dompurifyConfig",
        "themeCSS",
        "fontFamily",
        "altFontFamily",
      ]),
    );
  });
});

describe("stripSvgLinks", () => {
  it("unwraps links and keeps what they wrap", () => {
    expect(
      stripSvgLinks(
        '<svg><a xlink:href="https://example.com" target="_blank"><g class="node"><text>A</text></g></a></svg>',
      ),
    ).toBe('<svg><g class="node"><text>A</text></g></svg>');
    expect(
      stripSvgLinks(
        '<g><A href="https://e.com">x</A ><a/><a\nhref="y">z</a></g>',
      ),
    ).toBe("<g>xz</g>");
  });

  it("reads quoted attribute values whole", () => {
    expect(
      stripSvgLinks(
        `<a title="a > b" data-x='<a>'><text title=">">t</text></a>`,
      ),
    ).toBe('<text title=">">t</text>');
  });

  it("keeps every other element, even ones whose name starts with a", () => {
    const svg =
      '<svg aria-roledescription="flowchart"><animateTransform attributeName="x"/><altGlyph>g</altGlyph><text>&lt;a href="x"&gt;</text></svg>';
    expect(stripSvgLinks(svg)).toBe(svg);
  });

  it("keeps text without markup and drops an unterminated link tag", () => {
    expect(stripSvgLinks("plain text")).toBe("plain text");
    expect(stripSvgLinks("<g>x</g><a href='y")).toBe("<g>x</g>");
  });
});

describe("diagramError", () => {
  it("says what failed in one bounded message", () => {
    expect(diagramError(new Error("Parse error on line 2"))).toBe(
      "Parse error on line 2",
    );
    expect(diagramError("  bad  ")).toBe("bad");
    expect(diagramError({})).toBe("The diagram could not be rendered.");
    expect(diagramError(new Error(""))).toBe(
      "The diagram could not be rendered.",
    );
    const long = diagramError(new Error("x".repeat(1000)));
    expect(long).toHaveLength(401);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("DiagramCache", () => {
  it("keys drawings by theme and source", () => {
    expect(DiagramCache.key("light", "graph TD")).not.toBe(
      DiagramCache.key("dark", "graph TD"),
    );
  });

  it("evicts the least recently used drawing", () => {
    const cache = new DiagramCache(2);
    cache.set("a", "A");
    cache.set("b", "B");
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
    cache.set("a", "A2");
    cache.set("d", "D");
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("a")).toBe("A2");
  });
});

describe("serialized", () => {
  it("runs one call at a time, in order, past failures", async () => {
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = serialized(async (name: string) => {
      events.push(`start ${name}`);
      if (name === "a") await gate;
      if (name === "b") throw new Error("b failed");
      events.push(`end ${name}`);
      return name;
    });
    const a = run("a");
    const b = run("b");
    const c = run("c");
    await Promise.resolve();
    expect(events).toEqual(["start a"]);
    release();
    await expect(a).resolves.toBe("a");
    await expect(b).rejects.toThrow("b failed");
    await expect(c).resolves.toBe("c");
    expect(events).toEqual(["start a", "end a", "start b", "start c", "end c"]);
  });
});
