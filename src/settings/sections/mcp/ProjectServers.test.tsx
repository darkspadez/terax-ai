import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/skills/api", () => ({
  decideProjectTrust: vi.fn(),
  revokeProjectTrust: vi.fn(),
}));

import type { ProjectServers } from "@/modules/mcp/lib/projectServers";
import { ProjectServersSection } from "./ProjectServers";

const ID = "prj-0123456789ab-ba9876543210";

function listing(overrides: Partial<ProjectServers> = {}): ProjectServers {
  return {
    project: {
      key: "/real/proj",
      root: "/work/proj",
      workspace: { kind: "local" },
    },
    path: "/work/proj/.mcp.json",
    state: "pending",
    hash: "h1",
    problem: null,
    entries: [
      {
        title: "db",
        detail: "npx -y db-mcp · reads DB_URL from your environment",
      },
    ],
    servers: [],
    ...overrides,
  };
}

function render(value: ProjectServers): string {
  return renderToStaticMarkup(
    <ProjectServersSection
      listing={value}
      records={{}}
      card={(server) => <div key={server.id}>card:{server.name}</div>}
      onError={() => {}}
    />,
  );
}

describe("ProjectServersSection", () => {
  it("shows what an undecided file runs, with the choice", () => {
    const html = render(listing());
    expect(html).toContain("Project proj");
    expect(html).toContain("/work/proj/.mcp.json");
    expect(html).toContain("npx -y db-mcp");
    expect(html).toContain("Use servers");
    expect(html).toContain("Don&#x27;t use");
    expect(html).not.toContain("card:");
  });

  it("lists the servers of an allowed file as cards", () => {
    const html = render(
      listing({
        state: "allowed",
        servers: [
          {
            id: ID,
            name: "db",
            transport: {
              type: "stdio",
              command: "npx",
              args: ["-y", "db-mcp"],
              env: [],
              cwd: null,
            },
            entryHash: "e1",
            variables: [],
            warnings: [],
            problem: null,
          },
          {
            id: "prj-0123456789ab-111111111111",
            name: "sock",
            transport: null,
            entryHash: "e2",
            variables: [],
            warnings: [],
            problem: "WebSocket servers are not supported",
          },
        ],
      }),
    );
    expect(html).toContain("card:db");
    expect(html).toContain(
      "Cannot be used: WebSocket servers are not supported",
    );
    expect(html).toContain("Stop using");
    expect(html).not.toContain("npx -y db-mcp ·");
  });

  it("names why a file cannot be used", () => {
    const html = render(
      listing({
        state: "unreviewable",
        hash: null,
        problem: ".mcp.json links outside the project",
        entries: [],
      }),
    );
    expect(html).toContain(
      "Cannot be used: .mcp.json links outside the project",
    );
    expect(html).not.toContain("Use servers");
  });
});
