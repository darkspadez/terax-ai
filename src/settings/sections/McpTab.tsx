import { lazy, Suspense } from "react";

const McpSection = lazy(() =>
  import("./mcp/McpSection").then((m) => ({ default: m.McpSection })),
);

/** Settings > MCP, loaded when the tab is first shown. */
export function McpTab() {
  return (
    <Suspense fallback={null}>
      <McpSection />
    </Suspense>
  );
}
