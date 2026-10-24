// What a Mermaid block shows besides the diagram itself. The block
// (MermaidBlock.tsx) hands these to the lazily loaded renderer, which stays
// free of the block's modules, so its chunk holds Mermaid alone.

const MAX_ERROR = 400;

/** A render failure as one short message (Mermaid can quote the whole source). */
export function diagramError(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const message = text.trim() || "The diagram could not be rendered.";
  return message.length > MAX_ERROR
    ? `${message.slice(0, MAX_ERROR)}…`
    : message;
}

export function DiagramPending() {
  return (
    <p className="m-0 px-3 py-2.5 text-[11px] text-muted-foreground">
      Rendering diagram…
    </p>
  );
}

/** A diagram that could not be drawn: the error, then its source. */
export function DiagramError({
  message,
  source,
}: {
  message: string;
  source: string;
}) {
  return (
    <div className="px-3 py-2.5">
      <p className="m-0 mb-2 whitespace-pre-wrap wrap-break-word font-mono text-[11px] text-destructive">
        Could not render this diagram: {message}
      </p>
      <pre className="m-0 font-mono text-[11.5px] leading-relaxed text-foreground">
        {source}
      </pre>
    </div>
  );
}
