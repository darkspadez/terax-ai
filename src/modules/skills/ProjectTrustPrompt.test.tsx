import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  decideProjectTrust: vi.fn(),
  projectTrustStatus: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { trustItem, trustStatus } from "./fixtures";
import { ProjectTrustPrompt } from "./ProjectTrustPrompt";

function render(items: Parameters<typeof trustStatus>[0]): string {
  return renderToStaticMarkup(
    <ProjectTrustPrompt
      status={trustStatus(items)}
      onDismiss={() => {}}
      onDecided={() => {}}
    />,
  );
}

describe("ProjectTrustPrompt", () => {
  it("lists what the project provides before asking", () => {
    const html = render([trustItem()]);
    expect(html).toContain("Use the skills in proj?");
    expect(html).toContain("/work/proj/.claude/skills");
    expect(html).toContain("deploy");
    expect(html).toContain("Deploys the app.");
    expect(html).toContain("Until then the AI never sees them.");
    expect(html).not.toContain('role="checkbox"');
    expect(html).toContain("Use skills");
  });

  it("lets each item be chosen when the project provides several", () => {
    const html = render([
      trustItem({ kind: "claude-skills" }),
      trustItem({
        kind: "terax-skills",
        path: "/work/proj/.terax/skills",
        state: "changed",
      }),
    ]);
    expect(html.match(/role="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("Changed since your answer");
    expect(html).toContain("Use selected");
  });

  it("asks about a project's MCP servers, listing each command or URL", () => {
    const html = render([
      trustItem({
        kind: "mcp-json",
        label: "MCP servers in .mcp.json",
        path: "/work/proj/.mcp.json",
        entries: [
          {
            title: "db",
            detail: "npx -y db-mcp · reads DB_URL from your environment",
          },
        ],
      }),
    ]);
    expect(html).toContain("Use the MCP servers in proj?");
    expect(html).toContain("/work/proj/.mcp.json");
    expect(html).toContain("npx -y db-mcp");
    expect(html).toContain("programs Terax starts with your rights");
    expect(html).not.toContain("Skills are instructions");
    expect(html).toContain("Use servers");
  });

  it("asks about skills and servers together", () => {
    const html = render([
      trustItem(),
      trustItem({ kind: "mcp-json", path: "/work/proj/.mcp.json" }),
    ]);
    expect(html).toContain("Use the skills and MCP servers in proj?");
    expect(html).toContain("Skills are instructions");
    expect(html).toContain("programs Terax starts with your rights");
    expect(html).toContain("Use selected");
  });

  it("asks about a project's TERAX.md, showing its size and first lines as text", () => {
    const html = render([
      trustItem({
        kind: "terax-md",
        label: "Instructions in TERAX.md",
        path: "/work/proj/TERAX.md",
        entries: [
          {
            title: "2.1 KB · 60 lines",
            detail: "# Rules\n<b>never</b> ask",
          },
        ],
      }),
    ]);
    expect(html).toContain("Use the project instructions in proj?");
    expect(html).toContain("/work/proj/TERAX.md");
    expect(html).toContain("2.1 KB · 60 lines");
    expect(html).toContain("# Rules\n&lt;b&gt;never&lt;/b&gt; ask");
    expect(html).not.toContain("<b>never</b>");
    expect(html).toContain("Terax adds them to every AI run here");
    expect(html).not.toContain("Skills are instructions");
    expect(html).not.toContain("programs Terax starts");
    expect(html).toContain("Use instructions");
  });

  it("asks about instructions, skills and servers together", () => {
    const html = render([
      trustItem({ kind: "terax-md", path: "/work/proj/TERAX.md" }),
      trustItem(),
      trustItem({ kind: "mcp-json", path: "/work/proj/.mcp.json" }),
    ]);
    expect(html).toContain(
      "Use the project instructions, skills and MCP servers in proj?",
    );
    expect(html).toContain("Terax adds them to every AI run here");
    expect(html).toContain("Skills are instructions");
    expect(html).toContain("programs Terax starts with your rights");
    expect(html.match(/role="checkbox"/g)).toHaveLength(3);
    expect(html).toContain("Use selected");
  });

  it("names what cannot be used and why", () => {
    const html = render([
      trustItem(),
      trustItem({
        kind: "terax-skills",
        path: "/work/proj/.terax/skills",
        hash: null,
        problem: "holds more than 10000 files, too many to review",
        state: "unreviewable",
      }),
    ]);
    expect(html).toContain(
      "Cannot be used: holds more than 10000 files, too many to review",
    );
  });
});
