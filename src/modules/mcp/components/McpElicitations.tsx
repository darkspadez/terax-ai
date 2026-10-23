import { lazy, Suspense } from "react";
import { useMcpRequests } from "../lib/requests";

const ElicitationCard = lazy(() =>
  import("./ElicitationCard").then((m) => ({ default: m.ElicitationCard })),
);

/** Requests for information from MCP servers, in the chat, oldest first. */
export function McpElicitations() {
  const requests = useMcpRequests((s) => s.elicitations);
  if (requests.length === 0) return null;
  return (
    <div className="max-h-[60%] shrink-0 space-y-2 overflow-y-auto border-t border-border/60 p-2">
      <Suspense fallback={null}>
        {requests.map((request) => (
          <ElicitationCard key={request.id} request={request} />
        ))}
      </Suspense>
    </div>
  );
}
