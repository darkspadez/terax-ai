import { PopoverContent } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/modules/explorer/FileIcon";
import type {
  McpPickerItem,
  McpPickerSection,
} from "@/modules/mcp/lib/pickerItems";
import { McpServerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef } from "react";

type Props = {
  files: readonly string[];
  /** Resources and templates of the window's MCP servers, after the files. */
  mcpSections: readonly McpPickerSection[];
  mcpStarting: boolean;
  activeIndex: number;
  indexing: boolean;
  truncated: boolean;
  hasWorkspace: boolean;
  onPick: (file: string) => void;
  onPickMcp: (item: McpPickerItem) => void;
  onHover: (index: number) => void;
};

export function FilePickerContent({
  files,
  mcpSections,
  mcpStarting,
  activeIndex,
  indexing,
  truncated,
  hasWorkspace,
  onPick,
  onPickMcp,
  onHover,
}: Props) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  let cursor = files.length - 1;

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={6}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      className="w-80 overflow-hidden rounded-lg border border-border/60 bg-popover p-0 shadow-xl"
    >
      <div className="max-h-72 overflow-y-auto">
        <SectionHeader caps>Workspace files</SectionHeader>
        {!hasWorkspace ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground">
            No workspace open
          </div>
        ) : indexing && files.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            <span>Indexing workspace…</span>
          </div>
        ) : files.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground">
            No matching files
          </div>
        ) : (
          <div className="py-1">
            {files.map((path, idx) => {
              const slash = path.lastIndexOf("/");
              const name = slash === -1 ? path : path.slice(slash + 1);
              const dir = slash === -1 ? "" : path.slice(0, slash);
              return (
                <button
                  key={path}
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  type="button"
                  onClick={() => onPick(path)}
                  onMouseEnter={() => onHover(idx)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
                    idx === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <FileIcon name={name} className="size-4 shrink-0" />
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className="truncate font-medium">{name}</span>
                    {dir && (
                      <span className="truncate text-[10.5px] text-muted-foreground">
                        {dir}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {truncated && (
              <div className="px-2.5 py-1 text-[10px] text-muted-foreground">
                Workspace is large - refine your query to narrow results.
              </div>
            )}
          </div>
        )}
        {mcpSections.map((section) => (
          <div key={section.serverId}>
            <SectionHeader
              title={`Resources of the MCP server ${section.serverName}: outside content`}
            >
              <HugeiconsIcon
                icon={McpServerIcon}
                size={11}
                strokeWidth={1.75}
                className="shrink-0"
              />
              <span className="truncate">{section.serverName}</span>
            </SectionHeader>
            <div className="py-1">
              {section.items.map((item) => {
                cursor += 1;
                const idx = cursor;
                const entry =
                  item.kind === "resource" ? item.resource : item.template;
                const address =
                  item.kind === "resource"
                    ? item.resource.uri
                    : item.template.uriTemplate;
                return (
                  <button
                    key={`${item.kind}-${address}`}
                    ref={(el) => {
                      itemRefs.current[idx] = el;
                    }}
                    type="button"
                    onClick={() => onPickMcp(item)}
                    onMouseEnter={() => onHover(idx)}
                    title={entry.description ?? address}
                    className={cn(
                      "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
                      idx === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    <FileIcon name={entry.name} className="size-4 shrink-0" />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className="truncate font-medium">
                        {entry.title ?? entry.name}
                      </span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {address}
                      </span>
                    </span>
                    {item.kind === "template" ? (
                      <span className="shrink-0 rounded border border-border/70 px-1 text-[9.5px] text-muted-foreground">
                        fill in
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {section.truncated && (
                <div className="px-2.5 py-1 text-[10px] text-muted-foreground">
                  More resources - refine your query to narrow results.
                </div>
              )}
            </div>
          </div>
        ))}
        {mcpStarting && mcpSections.length === 0 && (
          <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            <span>Starting MCP servers…</span>
          </div>
        )}
      </div>
    </PopoverContent>
  );
}

function SectionHeader({
  children,
  title,
  caps = false,
}: {
  children: React.ReactNode;
  title?: string;
  /** Small capitals, as for a fixed label (a server's name keeps its case). */
  caps?: boolean;
}) {
  return (
    <div
      title={title}
      className={cn(
        "sticky top-0 z-10 flex items-center gap-1.5 border-b border-border/60 bg-popover px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground/70",
        caps && "uppercase tracking-wide",
      )}
    >
      {children}
    </div>
  );
}
