import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) =>
    `asset://localhost/${encodeURIComponent(path)}`,
  invoke: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));

const { dirOf, joinPath, previewRehypePlugins } = await import("./localImages");
const { MarkdownImage } = await import("./MarkdownImage");

const asset = (path: string) =>
  `src="asset://localhost/${encodeURIComponent(path)}"`;

function render(markdown: string, file = "/repo/docs/README.md") {
  return renderToStaticMarkup(
    <Streamdown
      components={{ img: MarkdownImage }}
      rehypePlugins={previewRehypePlugins(dirOf(file))}
      mode="static"
      parseIncompleteMarkdown={false}
    >
      {markdown}
    </Streamdown>,
  );
}

describe("joinPath", () => {
  it("resolves dot segments without climbing above the root", () => {
    expect(joinPath("/repo/docs", "./img/a.png")).toBe("/repo/docs/img/a.png");
    expect(joinPath("/repo/docs", "../a.png")).toBe("/repo/a.png");
    expect(joinPath("/repo", "../../../a.png")).toBe("/a.png");
    expect(joinPath("C:\\repo\\docs", "..\\a.png")).toBe("C:/repo/a.png");
    expect(joinPath("C:/", "../a.png")).toBe("C:/a.png");
    expect(joinPath("//server/share", "a.png")).toBe("//server/share/a.png");
  });
});

describe("dirOf", () => {
  it("takes the folder of either separator", () => {
    expect(dirOf("/repo/README.md")).toBe("/repo");
    expect(dirOf("C:\\repo\\README.md")).toBe("C:\\repo");
    expect(dirOf("/README.md")).toBe("/");
    expect(dirOf("README.md")).toBe("");
  });
});

// crynta/terax-ai#1083: harden turned ./assets/logo.png into /assets/logo.png
// on the app's origin and blocked assets/logo.png outright.
describe("Markdown preview images", () => {
  it("loads images next to the document", () => {
    expect(render("![logo](./assets/logo.png)")).toContain(
      asset("/repo/docs/assets/logo.png"),
    );
    expect(render("![logo](assets/logo.png)")).toContain(
      asset("/repo/docs/assets/logo.png"),
    );
    expect(render("![up](../shot%201.png)")).toContain(
      asset("/repo/shot 1.png"),
    );
  });

  it("resolves images written as HTML", () => {
    expect(render('<p><img src="img/a.png" alt="a"></p>')).toContain(
      asset("/repo/docs/img/a.png"),
    );
  });

  it("never loads an asset URL written into the file", () => {
    const html = render(
      `![x](asset://localhost/${encodeURIComponent("/etc/secret.png")})`,
    );
    expect(html).not.toContain("secret");
  });

  it("fetches https images instead of handing them to the webview", () => {
    const html = render("![badge](https://img.shields.io/badge/a-b-c)");
    expect(html).not.toContain("img.shields.io");
    expect(html).not.toContain("Image blocked");
    expect(render("![x](http://example.com/x.png)")).toContain("not loaded");
  });
});
