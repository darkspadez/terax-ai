import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, Visitor } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeDist,
  chunkName,
  findViolations,
  packagesFromMap,
  parseHtmlAssets,
  staticImports,
  traceStartup,
} from "../../scripts/dist-graph.mjs";

/** Formula and diagram renderers: npm packages only their own chunks hold. */
const MARKDOWN_RENDERERS =
  /^(?:katex|mermaid|@mermaid-js\/.+|@streamdown\/.+)$/;

// Complements eager-budget.test.ts. That one walks the *source* import graph;
// this one reads what the bundler actually emitted, because chunk assignment
// can drag heavy code into the startup graph even when the source graph is
// clean (observed: React's CJS interop landed in the lazy `ai-sdk-shared`
// chunk, so the always-eager `react` chunk imported it, and with it every AI
// provider SDK and zod, in both windows). Preloaded bytes are paid by every
// launch, so the AI SDK, zod, Streamdown, CodeMirror and the icon set must stay
// reachable only through dynamic `import()`.

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The Safari (system WebKit, which WKWebView uses) each macOS release ships.
 * A chunk with syntax its WebKit cannot parse fails as a whole; in a startup
 * chunk that leaves the window blank (crynta/terax-ai#933, macOS 13.0.1).
 */
const SAFARI_OF_MACOS: Record<string, number> = {
  "13.0": 16.1,
  "13.1": 16.2,
  "13.2": 16.3,
  "13.3": 16.4,
  "14.0": 17.0,
};

/**
 * Syntax in `code` that WebKit learned late, with the first Safari that
 * parses it. Build targets lower class static blocks but never regular
 * expression features.
 */
function lateWebKitSyntax(code: string): Map<string, number> {
  const found = new Map<string, number>();
  const { program, errors } = parseSync("chunk.js", code);
  if (errors.length > 0) found.set("unparsable", Number.POSITIVE_INFINITY);
  new Visitor({
    StaticBlock: () => {
      found.set("class static block", 16.4);
    },
    Literal: (node) => {
      if (!("regex" in node) || !node.regex) return;
      if (/(?:^|[^\\])\(\?<[=!]/.test(node.regex.pattern)) {
        found.set("regex lookbehind", 16.4);
      }
      if (node.regex.flags.includes("v")) found.set("regex v flag", 17);
    },
  }).visit(program);
  return found;
}

describe("late WebKit syntax", () => {
  it("finds what Safari 16.1 to 16.3 cannot parse", () => {
    expect([
      ...lateWebKitSyntax(
        "class A{static{A.x=1}};const r=/(?<=a)b/,s=/(?<!a)b/;",
      ),
    ]).toEqual([
      ["class static block", 16.4],
      ["regex lookbehind", 16.4],
    ]);
    expect([...lateWebKitSyntax("const r=/[a--b]/v;")]).toEqual([
      ["regex v flag", 17],
    ]);
  });

  it("passes older syntax and escaped look-alikes", () => {
    expect(
      lateWebKitSyntax(
        "class A{static x=1;#y=2;m(){return #y in this}};const r=/\\(?<=a/,n=/(?<name>a)(?=b)/u;",
      ).size,
    ).toBe(0);
  });
});

describe("dist graph analyzer", () => {
  it("reads only static import edges, not dynamic ones", () => {
    const code = [
      'import{a as b}from"./one.js";import"./two.js";',
      'export{c}from"./three.js";export*from"./four.js";',
      'const lazy=()=>import("./lazy.js");',
      'import.meta.url;import x,{y}from"../up.js";',
      'const s="import {z} from \\"./string.js\\"";',
      'import{r}from"pkg";',
    ].join("\n");
    expect(staticImports(code).sort()).toEqual(
      ["../up.js", "./four.js", "./one.js", "./three.js", "./two.js"].sort(),
    );
  });

  it("collects entry scripts, modulepreloads and stylesheets from html", () => {
    const html = `<head>
      <script>var inline = 1</script>
      <script type="module" crossorigin src="/assets/main-AAAA1111.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/react-BBBB2222.js">
      <link rel="stylesheet" crossorigin href="/assets/app-CCCC3333.css">
      <link rel="icon" href="/logo.png">
    </head>`;
    expect(parseHtmlAssets(html)).toEqual({
      scripts: ["/assets/main-AAAA1111.js"],
      preloads: ["/assets/react-BBBB2222.js"],
      styles: ["/assets/app-CCCC3333.css"],
    });
  });

  it("strips the content hash from chunk names", () => {
    expect(chunkName("assets/ai-sdk-shared-CAWduq6e.js")).toBe("ai-sdk-shared");
    expect(chunkName("assets/cm-lang-css-Bzp8a_YD.js")).toBe("cm-lang-css");
    expect(chunkName("assets/react-Cg0CyNNP.js")).toBe("react");
  });

  it("resolves npm packages through the isolated install's nested node_modules", () => {
    const map = JSON.stringify({
      sources: [
        "../../node_modules/.bun/zod@4.4.3/node_modules/zod/v4/core.js",
        "../../node_modules/.bun/@ai-sdk+gateway@3+969a6d035afea0f4/node_modules/@ai-sdk/gateway/dist/index.mjs",
        "../../src/main.tsx",
      ],
    });
    expect([...(packagesFromMap(map) ?? [])].sort()).toEqual([
      "@ai-sdk/gateway",
      "zod",
    ]);
    expect(packagesFromMap(null)).toBeNull();
  });

  it("follows transitive static imports and flags forbidden chunks with their importer", () => {
    // The shape of the original regression: react -> ai-sdk-shared -> ai-*.
    const files: Record<string, string> = {
      "index.html":
        '<script type="module" src="/assets/main-AAAA1111.js"></script>',
      "assets/main-AAAA1111.js": 'import"./react-BBBB2222.js";',
      "assets/react-BBBB2222.js": 'import{n}from"./ai-sdk-shared-CCCC3333.js";',
      "assets/ai-sdk-shared-CCCC3333.js":
        'import{z}from"./ai-anthropic-DDDD4444.js";',
      "assets/ai-anthropic-DDDD4444.js": "export const z=1;",
    };
    const trace = traceStartup(files["index.html"], (p) => files[p] ?? null);
    expect([...trace.files.keys()]).toHaveLength(4);
    expect(
      findViolations(trace).map((v) => [chunkName(v.file), v.via]),
    ).toEqual([
      ["ai-sdk-shared", "assets/react-BBBB2222.js"],
      ["ai-anthropic", "assets/ai-sdk-shared-CCCC3333.js"],
    ]);
  });

  it("catches heavy code hiding in an anonymous chunk, by signature and by sourcemap", () => {
    const files: Record<string, string> = {
      "index.html":
        '<script type="module" src="/assets/main-AAAA1111.js"></script>',
      "assets/main-AAAA1111.js":
        'import"./dist-BBBB2222.js";import"./esm-CCCC3333.js";',
      "assets/dist-BBBB2222.js": 'class E{};E.name="ZodError";',
      "assets/esm-CCCC3333.js": "export const x=1;",
      "assets/esm-CCCC3333.js.map": JSON.stringify({
        sources: [
          "../../node_modules/.bun/x/node_modules/@codemirror/state/a.js",
        ],
      }),
    };
    const trace = traceStartup(files["index.html"], (p) => files[p] ?? null);
    expect(findViolations(trace).map((v) => v.reason)).toEqual([
      'contains zod code ("ZodError")',
      'bundles package "@codemirror/state"',
    ]);
  });

  it("passes a clean graph and counts bytes once per chunk", () => {
    const files: Record<string, string> = {
      "index.html":
        '<script type="module" src="/assets/main-AAAA1111.js"></script><link rel="modulepreload" href="/assets/react-BBBB2222.js">',
      "assets/main-AAAA1111.js":
        'import"./react-BBBB2222.js";const l=()=>import("./ai-openai-EEEE5555.js");',
      "assets/react-BBBB2222.js": "export const r=1;",
    };
    const trace = traceStartup(files["index.html"], (p) => files[p] ?? null);
    expect(findViolations(trace)).toEqual([]);
    expect(trace.missing).toEqual([]);
    expect(trace.files.size).toBe(2);
  });
});

describe("built startup graph", () => {
  let outDir = "";

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "terax-dist-budget-"));
    // Sourcemaps list every module inside each chunk, so the package check does
    // not depend on how a chunk happens to be named. Built into a temp dir:
    // the real dist/ is untouched.
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/vite/bin/vite.js"),
        "build",
        "--outDir",
        outDir,
        "--emptyOutDir",
        "--sourcemap",
        "--logLevel",
        "error",
      ],
      {
        cwd: root,
        // TERAX_BENCH is explicitly off: a shipped build must not contain the app-lab driver.
        env: { ...process.env, NODE_ENV: "production", TERAX_BENCH: "" },
        stdio: "pipe",
        timeout: 240_000,
      },
    );
  }, 300_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  for (const html of ["index.html", "settings.html"]) {
    it(`${html}: no AI SDK, zod, Streamdown, CodeMirror or icon-set code is preloaded`, () => {
      const result = analyzeDist(outDir, [html])[html];
      expect(result.trace.missing).toEqual([]);
      expect(result.trace.files.size).toBeGreaterThan(5);
      expect(
        result.violations.map(
          (v) => `${v.file}: ${v.reason}${v.via ? ` (via ${v.via})` : ""}`,
        ),
      ).toEqual([]);
    });
  }

  it("keeps the heavy stacks lazily loadable: they exist and are reached by dynamic import", () => {
    const assets = join(outDir, "assets");
    const chunks = readdirSync(assets).filter((f) => f.endsWith(".js"));
    const texts = new Map(
      chunks.map((f) => [f, readFileSync(join(assets, f), "utf8")]),
    );
    const startup = new Set(
      ["index.html", "settings.html"].flatMap((html) => [
        ...analyzeDist(outDir, [html])[html].trace.files.keys(),
      ]),
    );
    for (const stem of [
      "ai-sdk-shared",
      "ai-anthropic",
      "streamdown",
      "codemirror",
      "iconEngine",
      "mathPlugin",
    ]) {
      const file = chunks.find((f) => chunkName(f) === stem);
      expect(file, `${stem} chunk should be emitted`).toBeDefined();
      expect(startup.has(`assets/${file}`), `${stem} must not be startup`).toBe(
        false,
      );
      const referenced = [...texts].some(
        ([other, code]) => other !== file && code.includes(file as string),
      );
      expect(referenced, `${stem} must be referenced by a dynamic import`).toBe(
        true,
      );
    }
  });

  it("loads the formula and diagram renderers on demand, not with the preview or chat", () => {
    const assets = join(outDir, "assets");
    const readChunk = (rel: string) => {
      const file = join(outDir, rel);
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    };
    // The chunks holding the preview pane and the chat's reply renderer, and
    // everything they import statically.
    const holders = readdirSync(assets)
      .filter((file) => file.endsWith(".js.map"))
      .filter((file) =>
        (
          JSON.parse(readFileSync(join(assets, file), "utf8")) as {
            sources: string[];
          }
        ).sources.some((source) =>
          /src\/(?:modules\/markdown\/MarkdownPreviewPane|components\/ai-elements\/message)\.tsx$/.test(
            source,
          ),
        ),
      )
      .map((file) => file.replace(/\.map$/, ""));
    expect(holders.length).toBeGreaterThan(0);
    const trace = traceStartup(
      holders
        .map((file) => `<script type="module" src="/assets/${file}"></script>`)
        .join(""),
      readChunk,
    );
    expect(trace.missing).toEqual([]);
    expect(
      [...trace.files].flatMap(([file, info]) =>
        [...(info.packages ?? [])]
          .filter((pkg) => MARKDOWN_RENDERERS.test(pkg))
          .map((pkg) => `${file}: ${pkg}`),
      ),
    ).toEqual([]);
  });

  it("ships KaTeX's fonts as woff2 only", () => {
    const assets = readdirSync(join(outDir, "assets"));
    const fonts = assets.filter((file) => file.startsWith("KaTeX_"));
    expect(fonts.length).toBeGreaterThan(10);
    expect(fonts.filter((file) => !file.endsWith(".woff2"))).toEqual([]);
    const css = assets
      .filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(join(outDir, "assets", file), "utf8"))
      .filter((text) => text.includes("font-family:KaTeX_Main"));
    expect(css).toHaveLength(1);
    expect(css[0]).not.toMatch(/\.(?:woff|ttf)\)/);
  });

  it("bundles one shared Lezer highlighter for parsers and themes", () => {
    const assets = join(outDir, "assets");
    const sources = new Set<string>();
    for (const file of readdirSync(assets).filter((f) =>
      f.endsWith(".js.map"),
    )) {
      const map = JSON.parse(readFileSync(join(assets, file), "utf8")) as {
        sources: string[];
      };
      for (const source of map.sources) {
        if (source.includes("/node_modules/@lezer/highlight/")) {
          sources.add(source);
        }
      }
    }
    expect([...sources]).toHaveLength(1);
  });

  it("refuses to build the app-lab driver without its own identifier, and under the product one", () => {
    const build = (extra: Record<string, string>) =>
      execFileSync(
        process.execPath,
        [
          join(root, "node_modules/vite/bin/vite.js"),
          "build",
          "--outDir",
          join(outDir, "guarded"),
          "--logLevel",
          "error",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_ENV: "production",
            TERAX_BENCH: "1",
            ...extra,
          },
          stdio: "pipe",
          timeout: 60_000,
        },
      );
    const failure = (extra: Record<string, string>): string => {
      try {
        build(extra);
      } catch (error) {
        return String((error as { stderr?: Buffer }).stderr ?? error);
      }
      return "";
    };
    expect(failure({ TERAX_BENCH_IDENTIFIER: "" })).toContain(
      "TERAX_BENCH_IDENTIFIER",
    );
    expect(failure({ TERAX_BENCH_IDENTIFIER: "app.crynta.terax" })).toContain(
      "not the product identifier",
    );
    // Nothing was emitted by either attempt.
    expect(existsSync(join(outDir, "guarded"))).toBe(false);
  });

  it("parses in the WebKit of the oldest macOS the bundle declares", () => {
    const config = JSON.parse(
      readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { bundle: { macOS: { minimumSystemVersion: string } } };
    const minimum = config.bundle.macOS.minimumSystemVersion;
    const safari = SAFARI_OF_MACOS[minimum];
    expect(safari, `Safari of macOS ${minimum}`).toBeDefined();
    const assets = join(outDir, "assets");
    const offenders = readdirSync(assets)
      .filter((file) => file.endsWith(".js"))
      .flatMap((file) =>
        [...lateWebKitSyntax(readFileSync(join(assets, file), "utf8"))]
          .filter(([, needs]) => needs > safari)
          .map(([feature, needs]) => `${file}: ${feature} (Safari ${needs})`),
      );
    expect(offenders).toEqual([]);
    // Parses every chunk (5.5 MB): a second alone, more beside other suites.
  }, 30_000);

  it("contains none of the app-lab benchmark driver (TERAX_BENCH is off)", () => {
    // The driver (src/bench) and its Tauri commands exist only in builds made with
    // TERAX_BENCH=1: `__TERAX_BENCH__` is the literal `false` otherwise, so its lazy import, the
    // chunks behind it and every bench-only string are removed before bundling.
    const markers = [
      "bench_config",
      "bench_window",
      "bench_exit",
      "__teraxBenchConfig",
      // The smoothness probe's seam (src/bench/smoothHooks.ts): product code reports to it
      // only behind __TERAX_BENCH__, and the lookup itself is gated too.
      "__teraxSmooth",
      "terax:bench:",
      "TERAX_BENCH",
      "__TERAX_BENCH__",
    ];
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : [join(dir, entry.name)],
      );
    const emitted = files(outDir).filter((file) => !file.endsWith(".map"));
    expect(
      emitted
        .map((file) => file.slice(outDir.length))
        .filter((file) => /bench/i.test(file)),
    ).toEqual([]);
    const offenders = emitted
      .filter((file) => /\.(js|html|css)$/.test(file))
      .flatMap((file) => {
        const code = readFileSync(file, "utf8");
        return markers
          .filter((marker) => code.includes(marker))
          .map((marker) => `${file.slice(outDir.length)}: ${marker}`);
      });
    expect(offenders).toEqual([]);
  });
});
