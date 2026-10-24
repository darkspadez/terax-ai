import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { mcpCallTarget, useMcpCatalog } from "@/modules/mcp";
import { isMcpToolOutput } from "@/modules/mcp/lib/results";
import { annotationLabels } from "@/modules/mcp/lib/toolSchema";
import {
  Cancel01Icon,
  McpServerIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { memo } from "react";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

function useTarget(toolName: string, toolMetadata: unknown) {
  // Subscribing keeps the card current if the server's tools change.
  const live = useMcpCatalog((s) => s.tools[toolName]);
  const target = mcpCallTarget(toolName, toolMetadata);
  return { live, serverName: target?.serverName, tool: target?.tool };
}

function Args({ input }: { input: unknown }) {
  const text =
    input === undefined ? "" : JSON.stringify(input ?? null, null, 2);
  if (!text || text === "{}") {
    return (
      <div className="text-[11px] text-muted-foreground">No arguments</div>
    );
  }
  return (
    <pre className="max-h-60 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
      {text}
    </pre>
  );
}

function McpToolApprovalImpl({
  part,
  toolName,
  onRespond,
}: {
  part: AnyToolPart;
  toolName: string;
  onRespond: (approved: boolean) => void;
}) {
  const { live, serverName, tool } = useTarget(
    toolName,
    (part as { toolMetadata?: unknown }).toolMetadata,
  );
  const labels = annotationLabels(live?.annotations);
  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500 oarlock-attention-pulse" />
        <HugeiconsIcon
          icon={McpServerIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
          {live?.title ?? tool ?? toolName}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          needs approval
        </span>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-mono text-foreground">{tool ?? toolName}</span>{" "}
          on the MCP server{" "}
          <span className="font-medium text-foreground">
            {serverName ?? "(not running)"}
          </span>
          {live?.trusted
            ? ", which you trust: it asks here because this conversation asks."
            : ", an outside program or service. Its tools ask every time unless you trust the server in Settings."}
        </div>
        {labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {labels.map((label) => (
              <span
                key={label}
                className="rounded border border-border/70 bg-muted/40 px-1.5 py-px text-[10px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
            <span className="text-[10px] text-muted-foreground/80">
              as the server describes it
            </span>
          </div>
        )}
        <Args input={part.input} />
      </div>
      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onRespond(false)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          Deny
        </Button>
        <Button
          size="sm"
          variant="default"
          onClick={() => onRespond(true)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
          Approve
        </Button>
      </div>
    </div>
  );
}

export const McpToolApproval = memo(McpToolApprovalImpl);

const STATE_DOT: Record<AnyToolPart["state"], string> = {
  "approval-requested": "bg-amber-500",
  "approval-responded": "bg-sky-500",
  "input-streaming": "bg-muted-foreground/40",
  "input-available": "bg-amber-500",
  "output-available": "bg-transparent border border-muted-foreground/40",
  "output-denied": "bg-orange-500",
  "output-error": "bg-destructive",
};

function McpOutput({ output }: { output: unknown }) {
  if (!isMcpToolOutput(output)) return <Args input={output} />;
  return (
    <div className="space-y-1.5">
      {output.content.map((part, i) =>
        part.type === "text" ? (
          <pre
            // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder.
            key={i}
            className="max-h-72 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
          >
            {part.text}
          </pre>
        ) : (
          <img
            // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder.
            key={i}
            alt="Returned by the server"
            src={`data:${part.mediaType};base64,${part.data}`}
            className="max-h-60 max-w-full rounded-md border border-border/60"
          />
        ),
      )}
      {output.notes.map((note) => (
        <div key={note} className="text-[10.5px] text-muted-foreground">
          {note}
        </div>
      ))}
    </div>
  );
}

/**
 * An MCP call in the transcript, marked as coming from an outside server:
 * its result is the server's, untrusted, not Oarlock's.
 */
function McpToolCallImpl({
  part,
  toolName,
}: {
  part: AnyToolPart;
  toolName: string;
}) {
  const { serverName, tool } = useTarget(
    toolName,
    (part as { toolMetadata?: unknown }).toolMetadata,
  );
  const state =
    part.state === "approval-requested" ? "output-denied" : part.state;
  const output = "output" in part ? part.output : undefined;
  const errorText = "errorText" in part ? part.errorText : undefined;
  const isError = state === "output-error";
  return (
    <Collapsible defaultOpen={isError} className="group/tool not-prose w-full">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
          "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span
          className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])}
        />
        <HugeiconsIcon
          icon={McpServerIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">
          {serverName ?? "MCP"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {tool ?? toolName}
        </span>
        <span
          className="shrink-0 rounded border border-border/70 px-1 text-[9.5px] text-muted-foreground"
          title="Returned by an MCP server: outside content, not Oarlock's"
        >
          external
        </span>
        {isError && (
          <span className="shrink-0 text-[10px] font-medium text-destructive">
            failed
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="oarlock-collapsible-content">
        <div className="mt-1 ml-3 space-y-2 border-l border-border/60 pb-1 pl-3">
          <div className="space-y-1">
            <div className="text-[10px] font-medium text-muted-foreground">
              Arguments
            </div>
            <Args input={part.input} />
          </div>
          {errorText ? (
            <div className="space-y-1">
              <div className="text-[10px] font-medium text-destructive">
                Error
              </div>
              <pre className="max-h-40 overflow-auto rounded-md bg-destructive/10 p-2 font-mono text-[11px] whitespace-pre-wrap text-destructive">
                {errorText}
              </pre>
            </div>
          ) : output !== undefined ? (
            <div className="space-y-1">
              <div className="text-[10px] font-medium text-muted-foreground">
                Result from {serverName ?? "the server"} (untrusted)
              </div>
              <McpOutput output={output} />
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export const McpToolCall = memo(McpToolCallImpl);
