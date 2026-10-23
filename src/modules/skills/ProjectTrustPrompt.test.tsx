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
