import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  type OsNotificationResult,
  testAgentOsNotification,
} from "@/modules/agents/lib/notify";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { ThemePref } from "@/modules/settings/store";
import {
  setAgentNotificationSound,
  setAgentNotifications,
  setAutostart,
  setConfirmCloseRunningTerminal,
  setDefaultWorkspaceEnv,
  setExplorerGitDecorations,
  setTerminalLinksInPreview,
  setRestoreWindowState,
  setShowHidden,
  setTerminalCursorBlink,
  setTerminalCursorStyle,
  setTerminalCustomShader,
  setTerminalFontFamily,
  setTerminalFontFeatures,
  setTerminalFontSize,
  setTerminalFontWeight,
  setTerminalLetterSpacing,
  setTerminalLigatures,
  setTerminalLineHeight,
  setTerminalMinimumContrast,
  setTerminalRenderer,
  setTerminalScreenReader,
  setTerminalScrollback,
  setTerminalShell,
  setZoomLevel,
  TERMINAL_CUSTOM_SHADER_MAX_BYTES,
  TERMINAL_FONT_SIZES,
  TERMINAL_LINE_HEIGHTS,
  TERMINAL_MINIMUM_CONTRASTS,
  TERMINAL_SCROLLBACK_PRESETS,
} from "@/modules/settings/store";
import { parseFontFeatures } from "@/modules/terminal/lib/fontFeatures";
import { useTheme } from "@/modules/theme";
import {
  ComputerIcon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { TerminalBehaviorSettings } from "./TerminalBehaviorSettings";

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "System", icon: ComputerIcon },
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
];

const TERMINAL_FONT_WEIGHTS = [
  { value: "normal", label: "Normal" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semi-Bold" },
  { value: "bold", label: "Bold" },
] as const;
const TERMINAL_CURSOR_STYLES = [
  { value: "bar", label: "Bar" },
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
] as const;
const LETTER_SPACINGS = [-4, -3, -2, -1, 0, 1, 2, 3, 4] as const;

type ShellInfo = { name: string; path: string; integrated: boolean };
const SHELL_AUTO = "auto";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;
const NOTIFICATION_TEST_DELAY_MS = 2_000;

type NotificationTestState =
  | OsNotificationResult
  | "idle"
  | "waiting"
  | "sending";

export function GeneralSection() {
  const { mode, setMode } = useTheme();

  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  const terminalLinksInPreview = usePreferencesStore(
    (s) => s.terminalLinksInPreview,
  );
  const terminalRenderer = usePreferencesStore((s) => s.terminalRenderer);
  const terminalCustomShader = usePreferencesStore(
    (s) => s.terminalCustomShader,
  );
  const shaderInput = useRef<HTMLInputElement | null>(null);
  const [shaderError, setShaderError] = useState<string | null>(null);

  // Compiled here first, so a shader that does not build never reaches the
  // terminals and its errors show with their line numbers.
  const chooseShader = async (file: File | undefined) => {
    setShaderError(null);
    if (!file) return;
    if (file.size > TERMINAL_CUSTOM_SHADER_MAX_BYTES) {
      setShaderError(`${file.name}: larger than 256 KiB`);
      return;
    }
    try {
      const source = await file.text();
      const { validateCustomShader } = await import(
        "@/modules/terminal/ghostty/webgl/customShader"
      );
      const error = validateCustomShader(source);
      if (error) setShaderError(`${file.name}:\n${error}`);
      else await setTerminalCustomShader({ name: file.name, source });
    } catch (error) {
      setShaderError(`${file.name}: ${String(error)}`);
    }
  };
  const terminalScreenReader = usePreferencesStore(
    (s) => s.terminalScreenReader,
  );
  const terminalCursorBlink = usePreferencesStore((s) => s.terminalCursorBlink);
  const terminalCursorStyle = usePreferencesStore((s) => s.terminalCursorStyle);
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const terminalFontFeatures = usePreferencesStore(
    (s) => s.terminalFontFeatures,
  );
  const terminalFontWeight = usePreferencesStore((s) => s.terminalFontWeight);
  const terminalShell = usePreferencesStore((s) => s.terminalShell);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [wslDistros, setWslDistros] = useState<{ name: string }[]>([]);
  const defaultWorkspaceEnv = usePreferencesStore((s) => s.defaultWorkspaceEnv);
  const terminalLetterSpacing = usePreferencesStore(
    (s) => s.terminalLetterSpacing,
  );
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalLineHeight = usePreferencesStore((s) => s.terminalLineHeight);
  const terminalMinimumContrast = usePreferencesStore(
    (s) => s.terminalMinimumContrast,
  );
  const terminalLigatures = usePreferencesStore((s) => s.terminalLigatures);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);
  const confirmCloseRunningTerminal = usePreferencesStore(
    (s) => s.confirmCloseRunningTerminal,
  );
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const agentNotifications = usePreferencesStore((s) => s.agentNotifications);
  const agentNotificationSound = usePreferencesStore(
    (s) => s.agentNotificationSound,
  );
  const [notificationTest, setNotificationTest] =
    useState<NotificationTestState>("idle");
  const notificationTestPending =
    notificationTest === "waiting" || notificationTest === "sending";

  const testNotification = async () => {
    setNotificationTest("waiting");
    await new Promise((resolve) =>
      setTimeout(resolve, NOTIFICATION_TEST_DELAY_MS),
    );
    setNotificationTest("sending");
    setNotificationTest(await testAgentOsNotification(agentNotificationSound));
  };

  useEffect(() => {
    let alive = true;
    void isEnabled()
      .then((on) => {
        if (!alive) return;
        if (on !== usePreferencesStore.getState().autostart) {
          void setAutostart(on);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void invoke<ShellInfo[]>("pty_list_shells")
      .then(setShells)
      .catch(() => {});
    void invoke<{ name: string }[]>("wsl_list_distros")
      .then(setWslDistros)
      .catch(() => {});
  }, []);

  const onToggleAutostart = async (next: boolean) => {
    try {
      if (next) await enable();
      else await disable();
      await setAutostart(next);
    } catch (e) {
      console.error("autostart toggle failed", e);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="General"
        description="Mode, terminal, and startup."
      />

      <div className="flex flex-col gap-2">
        <Label>Appearance</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={cn(
                "group flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-card transition-all",
                mode === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">{o.label}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          For theme, background and customization, see the{" "}
          <strong className="font-medium text-foreground">Themes</strong> tab.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Zoom</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-muted-foreground">
              UI zoom level
            </span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {Math.round(zoomLevel * 100)}%
            </span>
          </div>
          <Slider
            value={[zoomLevel]}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            onValueChange={(v) => void setZoomLevel(v[0] ?? 1)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Explorer</Label>
        <SettingRow
          title="Show hidden files"
          description="Include dot-prefixed files and folders (.env, .gitignore, .config) in the file explorer and search."
        >
          <Switch
            checked={showHidden}
            onCheckedChange={(v) => void setShowHidden(v)}
          />
        </SettingRow>
        <SettingRow
          title="Git decorations"
          description="Tint changed files and dim gitignored entries in the file explorer."
        >
          <Switch
            checked={explorerGitDecorations}
            onCheckedChange={(v) => void setExplorerGitDecorations(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Web preview</Label>
        <SettingRow
          title="Open localhost links in the preview"
          description="Clicking a localhost or 127.0.0.1 link in a terminal opens it in a preview tab instead of the system browser."
        >
          <Switch
            checked={terminalLinksInPreview}
            onCheckedChange={(v) => void setTerminalLinksInPreview(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Terminal</Label>
        <SettingRow
          title="Terminal renderer"
          description="Automatic uses WebGPU with WebGL fallback. Choose WebGL for graphics compatibility. Applies to new terminals."
        >
          <Select
            value={terminalRenderer}
            onValueChange={(value) =>
              void setTerminalRenderer(value === "webgl" ? "webgl" : "auto")
            }
          >
            <SelectTrigger className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic</SelectItem>
              <SelectItem value="webgl">WebGL</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Custom shader"
          description="A Ghostty or Shadertoy shader (mainImage) drawn over every terminal frame, animated while the window has focus. Runs on the WebGL renderer; terminals already open on WebGPU pick it up when reopened."
        >
          <div className="flex items-center gap-2">
            <span className="max-w-36 truncate text-[12px] text-muted-foreground">
              {terminalCustomShader?.name ?? "None"}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => shaderInput.current?.click()}
            >
              Choose…
            </Button>
            {terminalCustomShader ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setShaderError(null);
                  void setTerminalCustomShader(null);
                }}
              >
                Remove
              </Button>
            ) : null}
            <input
              ref={shaderInput}
              type="file"
              accept=".glsl,.frag,.fs,.txt,text/plain"
              className="hidden"
              onChange={(event) => {
                void chooseShader(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        </SettingRow>
        {shaderError ? (
          <div
            role="alert"
            className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 font-mono text-[11px] text-destructive"
          >
            {shaderError}
          </div>
        ) : null}
        <SettingRow
          title="Screen reader support"
          description="Expose terminal output as accessible text. Page Up and Page Down browse history when the output region is focused."
        >
          <Switch
            checked={terminalScreenReader}
            onCheckedChange={(value) => void setTerminalScreenReader(value)}
          />
        </SettingRow>
        <SettingRow
          title="Cursor blinking"
          description="Blink the terminal cursor. Off by default for lower idle CPU, matching VS Code and the macOS terminal."
        >
          <Switch
            checked={terminalCursorBlink}
            onCheckedChange={(v) => void setTerminalCursorBlink(v)}
          />
        </SettingRow>
        <SettingRow
          title="Cursor style"
          description="Shape of the terminal cursor."
        >
          <Select
            value={terminalCursorStyle}
            onValueChange={(v) => void setTerminalCursorStyle(v)}
          >
            <SelectTrigger
              value={terminalCursorStyle}
              className="h-8 w-28 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_CURSOR_STYLES.map((style) => (
                <SelectItem
                  key={style.value}
                  value={style.value}
                  className="text-[12px]"
                >
                  {style.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <FontFamilyInput
          value={terminalFontFamily}
          onCommit={(v) => void setTerminalFontFamily(v)}
        />
        <FontFeaturesInput
          value={terminalFontFeatures}
          onCommit={(v) => void setTerminalFontFeatures(v)}
        />
        <SettingRow
          title="Font weight"
          description="Thickness of terminal characters"
        >
          <Select
            value={terminalFontWeight}
            onValueChange={(v) => void setTerminalFontWeight(v)}
          >
            <SelectTrigger
              value={terminalFontWeight}
              className="h-8 w-28 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_WEIGHTS.map((w) => (
                <SelectItem
                  key={w.value}
                  value={w.value}
                  className="text-[12px]"
                >
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Font ligatures"
          description={
            terminalLigatures && terminalLetterSpacing !== 0
              ? "Not drawn while letter spacing is set."
              : "Draw sequences such as -> and != as one shape when the font has ligatures, as JetBrains Mono does."
          }
        >
          <Switch
            checked={terminalLigatures}
            onCheckedChange={(v) => void setTerminalLigatures(v)}
          />
        </SettingRow>
        <SettingRow
          title="Integrated terminal shell"
          description={
            shells.find((s) => s.path === terminalShell)?.integrated === false
              ? "Command blocks and directory tracking are unavailable for this shell."
              : wslDistros.length > 0
                ? "Shell for the integrated terminal. WSL spaces use the distro login shell. Existing tabs keep their shell."
                : "Shell for new terminal tabs. Existing tabs keep their shell."
          }
        >
          <Select
            value={terminalShell || SHELL_AUTO}
            onValueChange={(v) =>
              void setTerminalShell(v === SHELL_AUTO ? "" : v)
            }
          >
            <SelectTrigger
              value={terminalShell || SHELL_AUTO}
              className="h-8 w-40 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SHELL_AUTO} className="text-[12px]">
                Auto
              </SelectItem>
              {shells.map((s) => (
                <SelectItem key={s.path} value={s.path} className="text-[12px]">
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {(wslDistros.length > 0 || defaultWorkspaceEnv !== "local") && (
          <SettingRow
            title="Workspace environment"
            description="Where new spaces run, terminal and AI agent alike: Windows or a WSL distro. Existing spaces keep theirs; switch any from the status bar."
          >
            <Select
              value={defaultWorkspaceEnv}
              onValueChange={(v) => void setDefaultWorkspaceEnv(v)}
            >
              <SelectTrigger
                value={defaultWorkspaceEnv}
                className="h-8 w-40 text-[12px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local" className="text-[12px]">
                  Windows
                </SelectItem>
                {wslDistros.map((d) => (
                  <SelectItem
                    key={d.name}
                    value={`wsl:${d.name}`}
                    className="text-[12px]"
                  >
                    WSL: {d.name}
                  </SelectItem>
                ))}
                {defaultWorkspaceEnv.startsWith("wsl:") &&
                  !wslDistros.some(
                    (d) => `wsl:${d.name}` === defaultWorkspaceEnv,
                  ) && (
                    <SelectItem
                      value={defaultWorkspaceEnv}
                      className="text-[12px]"
                    >
                      {defaultWorkspaceEnv.slice("wsl:".length)} (unavailable)
                    </SelectItem>
                  )}
              </SelectContent>
            </Select>
          </SettingRow>
        )}
        <SettingRow
          title="Letter spacing"
          description="Extra horizontal space between characters (px). Use negative values to tighten Nerd Fonts."
        >
          <Select
            value={String(terminalLetterSpacing)}
            onValueChange={(v) => void setTerminalLetterSpacing(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LETTER_SPACINGS.map((v) => (
                <SelectItem key={v} value={String(v)} className="text-[12px]">
                  {v > 0 ? `+${v}` : v} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Line height"
          description="Row height as a multiple of the font size."
        >
          <Select
            value={String(terminalLineHeight)}
            onValueChange={(v) => void setTerminalLineHeight(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_LINE_HEIGHTS.map((v) => (
                <SelectItem key={v} value={String(v)} className="text-[12px]">
                  {v.toFixed(2)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Minimum contrast"
          description="Draw text that is hard to read against its background in white or black instead (WCAG contrast ratio)."
        >
          <Select
            value={String(terminalMinimumContrast)}
            onValueChange={(v) => void setTerminalMinimumContrast(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_MINIMUM_CONTRASTS.map((v) => (
                <SelectItem key={v} value={String(v)} className="text-[12px]">
                  {v === 1 ? "Off" : `${v}:1`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title="Font size" description="Terminal text size.">
          <Select
            value={String(terminalFontSize)}
            onValueChange={(v) => void setTerminalFontSize(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_SIZES.map((size) => (
                <SelectItem
                  key={size}
                  value={String(size)}
                  className="text-[12px]"
                >
                  {size} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Scrollback"
          description="Lines of history kept per terminal (about 1 KB per line at 120 columns). All terminals together stay within a shared memory budget."
        >
          <Select
            value={String(terminalScrollback)}
            onValueChange={(v) => void setTerminalScrollback(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_SCROLLBACK_PRESETS.map((lines) => (
                <SelectItem
                  key={lines}
                  value={String(lines)}
                  className="text-[12px]"
                >
                  {lines.toLocaleString()} lines
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Confirm before killing a running process"
          description="Ask before closing a terminal tab or quitting while a command is still running. Unsaved editor changes are always confirmed."
        >
          <Switch
            checked={confirmCloseRunningTerminal}
            onCheckedChange={(v) => void setConfirmCloseRunningTerminal(v)}
          />
        </SettingRow>
        <TerminalBehaviorSettings />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Agents</Label>
        <SettingRow
          title="Coding agent notifications"
          description="Alert when a coding agent needs your input or finishes. Native notification when Terax is unfocused, in-app otherwise."
        >
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!agentNotifications || notificationTestPending}
              title={notificationTestTitle(notificationTest)}
              onClick={() => void testNotification()}
            >
              {notificationTestLabel(notificationTest)}
            </Button>
            <Switch
              checked={agentNotifications}
              disabled={notificationTestPending}
              onCheckedChange={(v) => {
                setNotificationTest("idle");
                void setAgentNotifications(v);
              }}
            />
          </div>
        </SettingRow>
        <SettingRow
          title="Notification sound"
          description="Play a sound with agent notifications and in-app alerts."
        >
          <Switch
            checked={agentNotificationSound}
            disabled={!agentNotifications || notificationTestPending}
            onCheckedChange={(v) => void setAgentNotificationSound(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Startup</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Launch at login"
            description="Open Terax automatically when you sign in."
          >
            <Switch
              checked={autostart}
              onCheckedChange={(v) => void onToggleAutostart(v)}
            />
          </SettingRow>
          <SettingRow
            title="Restore window position & size"
            description="Reopen the main window where you left it. Applies on next launch."
          >
            <Switch
              checked={restoreWindowState}
              onCheckedChange={(v) => void setRestoreWindowState(v)}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

function notificationTestLabel(status: NotificationTestState): string {
  switch (status) {
    case "waiting":
      return "Switch apps...";
    case "sending":
      return "Sending...";
    case "requested":
      return "Requested";
    case "denied":
      return "Blocked";
    case "failed":
      return "Failed";
    default:
      return "Test in 2s";
  }
}

function notificationTestTitle(status: NotificationTestState): string {
  switch (status) {
    case "waiting":
      return "Switch to another app to verify native delivery";
    case "requested":
      return "The native notification was requested";
    case "denied":
      return "Notifications are disabled by the system";
    case "failed":
      return "Terax could not request a native notification";
    default:
      return "Send a native test notification after two seconds";
  }
}

function FontFeaturesInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  // A list that does not parse stays in the field with its error, unsaved.
  const commit = () => {
    const next = draft.trim();
    const parsed = parseFontFeatures(next);
    setError(parsed.error);
    if (parsed.error === null && next !== value) onCommit(next);
  };

  return (
    <SettingRow
      title="Font features"
      description={
        error ??
        "OpenType features as Ghostty's font-feature takes them, e.g. zero, ss01, -calt. Applies to the bundled JetBrains Mono and to installed fonts such as Nerd Fonts."
      }
    >
      <input
        type="text"
        value={draft}
        placeholder="Font defaults"
        aria-invalid={error !== null}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-8 w-48 rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-foreground/40 aria-invalid:border-destructive"
      />
    </SettingRow>
  );
}

function FontFamilyInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Commit (and trim) only on blur/Enter so a trailing space can be typed
  // mid-edit, e.g. "JetBrains Mono ".
  const commit = () => {
    const next = draft.trim();
    if (next !== draft) setDraft(next);
    if (next !== value) onCommit(next);
  };

  return (
    <SettingRow
      title="Font family"
      description='Nerd Font name for icons (e.g. "CaskaydiaCove Nerd Font Mono"). Leave blank to auto-detect.'
    >
      <input
        type="text"
        value={draft}
        placeholder="Auto-detect"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-8 w-48 rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-foreground/40"
      />
    </SettingRow>
  );
}
