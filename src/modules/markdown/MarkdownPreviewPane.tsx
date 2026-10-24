import { pathKey } from "@/lib/pathKey";
import { cn } from "@/lib/utils";
import { listenFsChanged } from "@/modules/explorer/lib/watch";
import { PrivacyRefusalNotice, usePrivacyRefusal } from "@/modules/mac-privacy";
import { useTheme, variantMode } from "@/modules/theme";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { authorizationSettled } from "@/modules/workspace/authorize";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useState } from "react";
import { MarkdownViewToggle } from "./MarkdownViewToggle";
import { dirOf } from "./localImages";
import {
  type PreviewReadResult,
  type PreviewStatus,
  previewAfterRead,
} from "./previewStatus";
import { RenderBoundary } from "./RenderBoundary";
import { RenderedMarkdown } from "./RenderedMarkdown";

type Props = {
  path: string;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
};

// Re-renders when the file changes on disk: the watcher reports it (the
// watch set covers Markdown tabs), and writes made through Oarlock (AI edits,
// editor saves) are announced at once.
function useFileRevision(path: string): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const key = pathKey(path);
    const bump = (paths: readonly string[]) => {
      if (paths.some((p) => pathKey(p) === key)) setRevision((r) => r + 1);
    };
    let alive = true;
    const unlisteners: (() => void)[] = [];
    const keep = (un: () => void) => {
      if (alive) unlisteners.push(un);
      else un();
    };
    void listenFsChanged(bump).then(keep);
    void getCurrentWebviewWindow()
      .listen<{ path: string }>("fs:file-written", (e) =>
        bump([e.payload.path]),
      )
      .then(keep);
    return () => {
      alive = false;
      for (const un of unlisteners) un();
    };
  }, [path]);
  return revision;
}

export function MarkdownPreviewPane({ path, visible, onSetView }: Props) {
  const [status, setStatus] = useState<PreviewStatus>({ kind: "loading" });
  const [shownPath, setShownPath] = useState(path);
  const revision = useFileRevision(path);
  const { activeTheme, resolvedMode } = useTheme();

  if (shownPath !== path) {
    setShownPath(path);
    setStatus({ kind: "loading" });
  }
  const refusal = usePrivacyRefusal(
    path,
    status.kind === "error" ? status.message : null,
  );

  useEffect(() => {
    // Each reported change of the file reads it again.
    void revision;
    let cancelled = false;
    authorizationSettled(path)
      .then(() =>
        invoke<PreviewReadResult>("fs_read_file", {
          path,
          workspace: currentWorkspaceEnv(),
        }),
      )
      .then(
        (result) => {
          if (!cancelled)
            setStatus((prev) => previewAfterRead(prev, { ok: true, result }));
        },
        (error) => {
          if (!cancelled)
            setStatus((prev) => previewAfterRead(prev, { ok: false, error }));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [path, revision]);

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <MarkdownViewToggle mode="rendered" onChange={onSetView} />
      <div className="flex-1 overflow-auto">
        {status.kind === "ready" ? (
          // The document alone sits in .markdown-body, so the GitHub-style
          // sheet never reaches the notices below.
          <article className="markdown-body select-text">
            <RenderBoundary resetKey={status.content} fallback={renderFailed}>
              <RenderedMarkdown
                content={status.content}
                baseDir={dirOf(path)}
                colorScheme={variantMode(activeTheme, resolvedMode)}
              />
            </RenderBoundary>
          </article>
        ) : (
          <div className="px-8 py-6">
            {status.kind === "loading" && (
              <p className="text-[12px] text-muted-foreground">Loading…</p>
            )}
            {status.kind === "error" &&
              (refusal ? (
                <PrivacyRefusalNotice
                  refusal={refusal}
                  title="Oarlock cannot open this file"
                  className="items-start text-left"
                />
              ) : (
                <p className="text-[12px] text-destructive">
                  Failed to read file: {status.message}
                </p>
              ))}
            {status.kind === "binary" && (
              <p className="text-[12px] text-muted-foreground">
                Binary file, cannot render as Markdown.
              </p>
            )}
            {status.kind === "toolarge" && (
              <p className="text-[12px] text-muted-foreground">
                File is {status.size} bytes; limit {status.limit}.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const renderFailed = () => (
  <p className="text-[12px] text-destructive">
    Failed to render this file as Markdown. Use the Raw view to inspect it.
  </p>
);
