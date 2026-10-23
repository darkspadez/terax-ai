import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

type LogLine = {
  seq: number;
  atMs: number;
  stream: "stderr" | "stdout" | "oarlock";
  text: string;
};

type LogPage = { lines: LogLine[]; next: number; gap: boolean };

/** Lines kept on screen; the backend keeps its own, larger ring. */
const MAX_SHOWN = 1000;
const POLL_MS = 1000;

function time(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * A server's log: what it wrote to stderr (and stray stdout), with Oarlock's
 * own notes on starting, connecting and failing. Read from the backend while
 * shown, a second apart.
 */
export function ServerLogs({ serverId }: { serverId: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const next = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    next.current = 0;
    setLines([]);
    const poll = async () => {
      try {
        const page = await invoke<LogPage>("mcp_logs", {
          serverId,
          after: next.current,
        });
        if (stopped) return;
        next.current = page.next;
        if (page.lines.length > 0) {
          setLines((old) => [...old, ...page.lines].slice(-MAX_SHOWN));
        }
        setError(null);
      } catch (e) {
        if (!stopped) setError(String(e));
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [serverId]);

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current && lines.length > 0)
      el.scrollTop = el.scrollHeight;
  }, [lines]);

  const copy = () => {
    const text = lines
      .map((l) => `${time(l.atMs)} ${l.stream} ${l.text}`)
      .join("\n");
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  const clear = () => {
    void invoke("mcp_logs_clear", { serverId }).then(() => setLines([]));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">
          Log
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={copy}
            disabled={lines.length === 0}
          >
            Copy
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={clear}
            disabled={lines.length === 0}
          >
            Clear
          </Button>
        </div>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
        className="h-48 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[10.5px] leading-relaxed select-text"
      >
        {error ? (
          <div className="text-destructive">{error}</div>
        ) : lines.length === 0 ? (
          <div className="text-muted-foreground">Nothing logged yet.</div>
        ) : (
          lines.map((line) => (
            <div
              key={line.seq}
              className={cn(
                "break-all whitespace-pre-wrap",
                line.stream === "oarlock" && "text-sky-700 dark:text-sky-400",
                line.stream === "stdout" && "text-muted-foreground",
              )}
            >
              <span className="text-muted-foreground/70">
                {time(line.atMs)}{" "}
              </span>
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
