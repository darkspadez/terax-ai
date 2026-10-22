import { notifyDocumentSaved } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type DocumentHost,
  type DocumentIo,
  DocumentSession,
  type DocumentState,
  type ReadResult,
} from "./documentSession";

/// Mirrors FORCE_MAX_READ_BYTES in src-tauri fs/file.rs.
export const FORCE_READ_LIMIT = 50 * 1024 * 1024;

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
};

const tauriDocumentIo: DocumentIo = {
  read: (path, force) =>
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
      force,
    }),
  mtime: (path) =>
    invoke<{ mtime: number }>("fs_stat", {
      path,
      workspace: currentWorkspaceEnv(),
    }).then(
      (stat) => stat.mtime,
      () => null,
    ),
  write: (path, content) =>
    invoke<number>("fs_write_file", {
      path,
      content,
      workspace: currentWorkspaceEnv(),
      source: "editor",
    }),
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function documentHost(
  setDoc: (doc: DocumentState) => void,
  setDirty: (dirty: boolean) => void,
): DocumentHost {
  return {
    state: setDoc,
    dirty: setDirty,
    saved: (path) => {
      // A successful write supersedes any earlier failure or conflict notice.
      toast.dismiss(`save-error:${path}`);
      toast.dismiss(`save-conflict:${path}`);
      notifyDocumentSaved(path);
    },
    saveFailed: (path, error) => {
      console.error("[save]", path, error);
      toast.error(`Could not save ${fileName(path)}`, {
        id: `save-error:${path}`,
        description: String(error),
      });
    },
    // Stays until the user acts, a write lands, or the pane leaves the path.
    conflict: (path, overwrite) => {
      toast.warning("File changed on disk", {
        id: `save-conflict:${path}`,
        description: `${fileName(path)} was modified by another program while you had unsaved changes. Overwrite to keep your version.`,
        duration: Number.POSITIVE_INFINITY,
        action: { label: "Overwrite", onClick: overwrite },
      });
    },
    released: (path) => {
      toast.dismiss(`save-conflict:${path}`);
    },
    autoSave: () => {
      const prefs = usePreferencesStore.getState();
      return {
        enabled: prefs.editorAutoSave,
        delay: prefs.editorAutoSaveDelay,
      };
    },
  };
}

export function useDocument({ path, onDirtyChange }: Options) {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [session] = useState(
    () => new DocumentSession(tauriDocumentIo, documentHost(setDoc, setDirty)),
  );

  useEffect(() => session.open(path), [session, path]);
  useEffect(() => () => session.close(), [session]);

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  return {
    doc,
    dirty,
    onChange: session.change,
    save: session.save,
    reload: session.reload,
    adoptDiskText: session.adoptDiskText,
    openAnyway: session.openAnyway,
  };
}
