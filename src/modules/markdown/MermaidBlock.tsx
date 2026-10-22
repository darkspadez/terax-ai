import {
  BlockChrome,
  ChatCodeBlock,
  useChatStreaming,
} from "@/components/ai-elements/chat-code";
import { lazy, Suspense } from "react";
import { DiagramError, DiagramPending, diagramError } from "./MermaidViews";
import { RenderBoundary } from "./RenderBoundary";

// Mermaid (with its diagram types, d3 and the rest) loads the first time a
// diagram is shown, never with the preview or the chat.
const MermaidDiagram = lazy(() =>
  import("./MermaidDiagram").then((m) => ({ default: m.MermaidDiagram })),
);

/**
 * A ```mermaid block of the Markdown preview or an AI reply, drawn as a
 * diagram. A reply still streaming shows the usual code placeholder; a
 * renderer that fails to load, or a diagram that fails to draw, shows the
 * source with the error.
 */
export function MermaidBlock({ code }: { code: string }) {
  const streaming = useChatStreaming();
  if (streaming) return <ChatCodeBlock code={code} lang="mermaid" />;
  const failed = (error: unknown) => (
    <DiagramError message={diagramError(error)} source={code} />
  );
  return (
    <BlockChrome label="mermaid" code={code}>
      <RenderBoundary resetKey={code} fallback={failed}>
        <Suspense fallback={<DiagramPending />}>
          <MermaidDiagram
            code={code}
            pending={<DiagramPending />}
            failed={failed}
          />
        </Suspense>
      </RenderBoundary>
    </BlockChrome>
  );
}
