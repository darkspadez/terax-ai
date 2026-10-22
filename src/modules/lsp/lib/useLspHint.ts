import { resolveLanguage } from "@/modules/editor/lib/languageResolver";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { LspActivation } from "@/modules/settings/store";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { detectBinary } from "./detect";
import { type LspPreset, rootMarkersOf, serverForLanguage } from "./presets";
import { type LspSessionStatus, useLspRuntimeStore } from "./runtimeStore";

export type LspHint =
  | { kind: "enable"; preset: LspPreset }
  | { kind: "install"; preset: LspPreset }
  | { kind: "active"; preset: LspPreset; status: LspSessionStatus }
  | { kind: "error"; preset: LspPreset; reason: string }
  | { kind: "no-root"; preset: LspPreset };

type HintInput = {
  preset: LspPreset | null;
  local: boolean;
  activation: LspActivation | undefined;
  /** Binary path, null when missing, undefined while unknown. */
  detected: string | null | undefined;
  /** The file's project root, null when it has none, undefined while unknown. */
  root: string | null | undefined;
  sessions: readonly {
    presetId: string;
    root: string;
    status: LspSessionStatus;
  }[];
  failure: string | undefined;
};

// An enabled server that cannot start for this file says why, instead of the
// pill silently disappearing.
export function lspHint(input: HintInput): LspHint | null {
  const { preset, activation, detected, root, failure } = input;
  if (!preset || !input.local || activation === "dismissed") return null;
  if (activation === "enabled") {
    const session = input.sessions.find(
      (s) =>
        s.presetId === preset.id && (root === undefined || s.root === root),
    );
    if (session) return { kind: "active", preset, status: session.status };
    if (failure) return { kind: "error", preset, reason: failure };
    if (detected === null) return { kind: "install", preset };
    if (root === null) return { kind: "no-root", preset };
    return null;
  }
  if (detected === undefined) return null;
  return detected ? { kind: "enable", preset } : { kind: "install", preset };
}

export function useLspHint(filePath: string | null): LspHint | null {
  const [langId, setLangId] = useState<string | null>(null);
  const envKind = useWorkspaceEnvStore((s) => s.env.kind);

  useEffect(() => {
    if (!filePath) {
      setLangId(null);
      return;
    }
    let cancelled = false;
    void resolveLanguage(filePath).then((result) => {
      if (cancelled) return;
      const ext = filePath.split(".").pop()?.toLowerCase() ?? null;
      setLangId(result?.id || ext);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const lspActivation = usePreferencesStore((s) => s.lspActivation);
  const preset = serverForLanguage(langId, customServers, lspActivation);
  const activation = preset ? lspActivation[preset.id] : undefined;
  const detected = useLspRuntimeStore((s) =>
    preset ? s.detected[preset.command] : undefined,
  );
  const sessions = useLspRuntimeStore((s) => s.sessions);
  const failure = useLspRuntimeStore((s) =>
    preset ? s.failed[preset.id] : undefined,
  );
  const [resolved, setResolved] = useState<{
    key: string;
    root: string | null;
  } | null>(null);
  const local = envKind === "local";
  const rootKey =
    preset && filePath && local && activation === "enabled"
      ? `${preset.id}\0${filePath}`
      : null;

  useEffect(() => {
    if (preset && local && activation === undefined) {
      void detectBinary(preset.command);
    }
  }, [preset, local, activation]);

  useEffect(() => {
    if (!rootKey || !preset || !filePath) return;
    let cancelled = false;
    void invoke<string | null>("lsp_resolve_root", {
      path: filePath,
      markers: rootMarkersOf(preset),
    })
      .catch(() => null)
      .then((root) => {
        if (!cancelled) setResolved({ key: rootKey, root });
      });
    return () => {
      cancelled = true;
    };
  }, [rootKey, preset, filePath]);

  return lspHint({
    preset,
    local,
    activation,
    detected,
    root: resolved?.key === rootKey ? resolved.root : undefined,
    sessions: Object.values(sessions),
    failure,
  });
}
