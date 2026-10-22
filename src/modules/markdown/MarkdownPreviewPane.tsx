import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { pathKey } from "@/lib/pathKey";
import { cn } from "@/lib/utils";
import { listenFsChanged } from "@/modules/explorer/lib/watch";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { authorizationSettled } from "@/modules/workspace/authorize";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import { splitFrontmatter } from "./frontmatter";
import { MarkdownImage } from "./MarkdownImage";
import "./markdownPreview.css";
import { MarkdownViewToggle } from "./MarkdownViewToggle";
import { dirOf } from "./localImages";
import { useMathPlugins } from "./math";
import { PreviewLink } from "./PreviewLink";
import { previewRehypePlugins } from "./previewPipeline";
import {
  type PreviewReadResult,
  type PreviewStatus,
  previewAfterRead,
} from "./previewStatus";
import { RenderBoundary } from "./RenderBoundary";

type Props = {
  path: string;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
};

const components = { a: PreviewLink, code: MarkdownCode, img: MarkdownImage };

// Re-renders when the file changes on disk: the watcher reports it (the
// watch set covers Markdown tabs), and writes made through Terax (AI edits,
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
  // Stable per folder so Streamdown's processor cache keeps hitting.
  const rehypePlugins = useMemo(
    () => previewRehypePlugins(dirOf(path)),
    [path],
  );

  if (shownPath !== path) {
    setShownPath(path);
    setStatus({ kind: "loading" });
  }

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
        <div className="markdown-body px-8 py-6">
          {status.kind === "loading" && (
            <p className="text-[12px] text-muted-foreground">Loading…</p>
          )}
          {status.kind === "error" && (
            <p className="text-[12px] text-destructive">
              Failed to read file: {status.message}
            </p>
          )}
          {status.kind === "binary" && (
            <p className="text-[12px] text-muted-foreground">
              Binary file — cannot render as markdown.
            </p>
          )}
          {status.kind === "toolarge" && (
            <p className="text-[12px] text-muted-foreground">
              File is {status.size} bytes; limit {status.limit}.
            </p>
          )}
          {status.kind === "ready" && (
            <RenderBoundary resetKey={status.content} fallback={renderFailed}>
              <RenderedFile
                content={status.content}
                rehypePlugins={rehypePlugins}
              />
            </RenderBoundary>
          )}
        </div>
      </div>
    </div>
  );
}

const renderFailed = () => (
  <p className="text-[12px] text-destructive">
    Failed to render this file as Markdown. Use the Raw view to inspect it.
  </p>
);

// A leading YAML frontmatter block shows as a key/value table, as on
// GitHub; values render as plain text. Math loads with the first file that
// has any.
function RenderedFile({
  content,
  rehypePlugins,
}: {
  content: string;
  rehypePlugins: ReturnType<typeof previewRehypePlugins>;
}) {
  const { entries, body } = splitFrontmatter(content);
  const plugins = useMathPlugins(body);
  return (
    <>
      {entries.length > 0 && (
        <table className="mb-6 w-full border-collapse text-[13px]">
          <tbody>
            {entries.map(([key, value], i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: keys may repeat; the list never reorders
              <tr key={`${key}-${i}`}>
                <th
                  scope="row"
                  className="w-1/4 border border-border px-3 py-1.5 text-left align-top font-medium"
                >
                  {key}
                </th>
                <td className="whitespace-pre-wrap border border-border px-3 py-1.5 align-top">
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Streamdown
        className="select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        components={components}
        rehypePlugins={rehypePlugins}
        plugins={plugins}
        mode="static"
        parseIncompleteMarkdown={false}
      >
        {body}
      </Streamdown>
    </>
  );
}
