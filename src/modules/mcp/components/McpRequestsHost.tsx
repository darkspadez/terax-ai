import { lazy, Suspense, useEffect, useRef } from "react";
import { registerRequestHost, useMcpRequests } from "../lib/requests";

const SamplingDialog = lazy(() =>
  import("./SamplingDialog").then((m) => ({ default: m.SamplingDialog })),
);

/**
 * Shows what the window's MCP servers ask of the user: the sampling dialog,
 * one request at a time, and (by opening the chat, where `McpElicitations`
 * shows it) a request for information. While none is mounted, requests are
 * refused: no window can show them. The dialog loads when first needed.
 */
export function McpRequestsHost({ onShowChat }: { onShowChat: () => void }) {
  useEffect(() => registerRequestHost(), []);
  const sampling = useMcpRequests((s) => s.sampling[0] ?? null);
  const elicitations = useMcpRequests((s) => s.elicitations.length);
  const seen = useRef(0);
  useEffect(() => {
    if (elicitations > seen.current) onShowChat();
    seen.current = elicitations;
  }, [elicitations, onShowChat]);
  if (!sampling) return null;
  return (
    <Suspense fallback={null}>
      <SamplingDialog key={sampling.id} request={sampling} />
    </Suspense>
  );
}
