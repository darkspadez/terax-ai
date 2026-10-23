import {
  type AgentLaunchCommands,
  DEFAULT_AGENT_LAUNCH_COMMANDS,
  normalizeAgentLaunchCommands,
} from "@/modules/agents/lib/launcher";
import {
  type AutocompleteProviderId,
  type CustomEndpoint,
  DEFAULT_AUTOCOMPLETE_MODEL,
  DEFAULT_MODEL_ID,
  DEFAULT_STT_PROVIDER,
  isResolvableModelId,
  LMSTUDIO_DEFAULT_BASE_URL,
  MLX_DEFAULT_BASE_URL,
  migrateLegacyCompatEndpoint,
  OLLAMA_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  type SttProvider,
  WHISPERCPP_DEFAULT_BASE_URL,
} from "@/modules/ai/config";
import {
  type ApprovalMode,
  normalizeApprovalMode,
} from "@/modules/ai/lib/approvalMode";
import {
  normalizeReasoningEffortByModel,
  type ReasoningEffort,
} from "@/modules/ai/lib/reasoningEffort";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";
import { parseFontFeatures } from "@/modules/terminal/lib/fontFeatures";
import { clampPaneLimit, MAX_PANES_PER_TAB } from "@/modules/terminal/lib/panes";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  currentPlatform,
  defaultTerminalBehavior,
  normalizeTerminalBehavior,
  type TerminalBehavior,
} from "./terminalBehavior";

export type ThemePref = "system" | "light" | "dark";

export const DEFAULT_THEME_ID = "terax-default";

export type BackgroundKind = "none" | "image";

export type TerminalCursorStyle = "bar" | "block" | "underline";

export const EDITOR_THEMES = [
  "kanagawa",
  "kanagawa-lotus",
  "kanagawa-dragon",
  "tokyo-night",
  "catppuccin-mocha",
  "catppuccin-latte",
  "rose-pine",
  "rose-pine-dawn",
  "everforest",
  "everforest-light",
  "dracula",
  "monokai-pro",
  "solarized-dark",
  "solarized-light",
  "nord",
  "gruvbox-dark",
  "atomone",
  "aura",
  "copilot",
  "github-dark",
  "github-light",
  "xcode-dark",
  "xcode-light",
] as const;

export type EditorThemeId = (typeof EDITOR_THEMES)[number];

/** "auto" follows the active app theme's editorTheme pairing (resolved live). */
export const EDITOR_THEME_AUTO = "auto" as const;
export type EditorThemePref = typeof EDITOR_THEME_AUTO | EditorThemeId;

export function isEditorThemeId(v: unknown): v is EditorThemeId {
  return (
    typeof v === "string" && (EDITOR_THEMES as readonly string[]).includes(v)
  );
}

export const EDITOR_THEME_MODE: Record<EditorThemeId, "light" | "dark"> = {
  kanagawa: "dark",
  "kanagawa-lotus": "light",
  "kanagawa-dragon": "dark",
  "tokyo-night": "dark",
  "catppuccin-mocha": "dark",
  "catppuccin-latte": "light",
  "rose-pine": "dark",
  "rose-pine-dawn": "light",
  everforest: "dark",
  "everforest-light": "light",
  dracula: "dark",
  "monokai-pro": "dark",
  "solarized-dark": "dark",
  "solarized-light": "light",
  nord: "dark",
  "gruvbox-dark": "dark",
  atomone: "dark",
  aura: "dark",
  copilot: "dark",
  "github-dark": "dark",
  "github-light": "light",
  "xcode-dark": "dark",
  "xcode-light": "light",
};

export const EDITOR_THEME_LABELS: Record<EditorThemeId, string> = {
  kanagawa: "Kanagawa Wave",
  "kanagawa-lotus": "Kanagawa Lotus",
  "kanagawa-dragon": "Kanagawa Dragon",
  "tokyo-night": "Tokyo Night",
  "catppuccin-mocha": "Catppuccin Mocha",
  "catppuccin-latte": "Catppuccin Latte",
  "rose-pine": "Rosé Pine",
  "rose-pine-dawn": "Rosé Pine Dawn",
  everforest: "Everforest Dark",
  "everforest-light": "Everforest Light",
  dracula: "Dracula",
  "monokai-pro": "Monokai Pro",
  "solarized-dark": "Solarized Dark",
  "solarized-light": "Solarized Light",
  nord: "Nord",
  "gruvbox-dark": "Gruvbox Dark",
  atomone: "Atom One",
  aura: "Aura",
  copilot: "Copilot",
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  "xcode-dark": "Xcode Dark",
  "xcode-light": "Xcode Light",
};

export type Preferences = {
  theme: ThemePref;
  themeId: string;
  backgroundKind: BackgroundKind;
  backgroundImageId: string | null;
  backgroundOpacity: number;
  backgroundBlur: number;
  windowVibrancy: boolean;
  /** A catalog model id or a custom endpoint's `compat-<id>`. */
  defaultModelId: string;
  editorTheme: EditorThemePref;
  editorFontSize: number;
  customInstructions: string;
  /** How new AI conversations start: gated tools ask, or run unasked. */
  aiApprovalMode: ApprovalMode;
  /** The reasoning effort last chosen for each model; absent is its default. */
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  autostart: boolean;
  restoreWindowState: boolean;
  autocompleteEnabled: boolean;
  autocompleteTrigger: AutocompleteTrigger;
  autocompleteProvider: AutocompleteProviderId;
  autocompleteModelId: string;
  lmstudioBaseURL: string;
  lmstudioModelId: string;
  mlxBaseURL: string;
  mlxModelId: string;
  ollamaBaseURL: string;
  ollamaModelId: string;
  openaiCompatibleBaseURL: string;
  openaiCompatibleModelId: string;
  openaiCompatibleContextLimit: number;
  customEndpoints: CustomEndpoint[];
  openrouterModelId: string;
  sttProvider: SttProvider;
  groqSttModel: string;
  whispercppBaseURL: string;
  favoriteModelIds: string[];
  recentModelIds: string[];
  vimMode: boolean;
  editorWordWrap: boolean;
  editorWordWrapColumn: number;
  diffViewMode: DiffViewMode;
  /** Indentation of new files and of files that have none to detect. */
  editorDefaultIndent: EditorDefaultIndent;
  showHidden: boolean;
  explorerGitDecorations: boolean;
  /**
   * The app's own file features (explorer, editor, previews, search,
   * watching, path completion, Open in Default App) reach every folder, not
   * only the authorized ones. At the user's own risk; off by default.
   */
  appAllFolders: boolean;
  /**
   * The AI tools reach every folder, not only the authorized ones. The
   * secret-path deny-list and tool approval still apply. Off by default.
   */
  aiAllFolders: boolean;
  /** Clicked localhost links in terminals open in the preview tab. */
  terminalLinksInPreview: boolean;
  terminalRenderer: "auto" | "webgl";
  terminalScreenReader: boolean;
  terminalCursorBlink: boolean;
  terminalCursorStyle: TerminalCursorStyle;
  terminalFontFamily: string;
  terminalFontWeight: string;
  terminalShell: string;
  terminalLetterSpacing: number;
  /** Cell height as a multiple of the font size. */
  terminalLineHeight: number;
  /**
   * OpenType features of the terminal font, as Ghostty's `font-feature`
   * takes them (`zero, ss01, -calt`); empty for the font's defaults.
   */
  terminalFontFeatures: string;
  /** Ghostty's minimum contrast for terminal text (1 is off). */
  terminalMinimumContrast: number;
  /** A Ghostty/Shadertoy shader run over terminal frames (WebGL renderer). */
  terminalCustomShader: TerminalCustomShader | null;
  /** Join punctuation such as `->` and `!=` with the font's ligatures. */
  terminalLigatures: boolean;
  terminalFontSize: number;
  terminalScrollback: number;
  /** Panes a terminal tab may be split into, 1 to `MAX_PANES_PER_TAB`. */
  terminalPaneLimit: number;
  terminalBehavior: TerminalBehavior;
  confirmCloseRunningTerminal: boolean;
  lastWslDistro: string | null;
  zoomLevel: number;
  agentNotifications: boolean;
  agentNotificationSound: boolean;
  agentLaunchCommands: AgentLaunchCommands;
  defaultWorkspaceEnv: string;
  shortcuts: Record<ShortcutId, KeyBinding[]>;
  editorAutoSave: boolean;
  editorAutoSaveDelay: number;
  editorFormatOnSave: boolean;
  editorFormatter: EditorFormatter;
  /** languageResolver id -> formatter, overriding the global default. */
  editorFormatterByLang: Record<string, EditorFormatter>;
  /** Shell template for the "custom" formatter; {file} is the quoted path. */
  editorCustomFormatCommand: string;
  lspActivation: Record<string, LspActivation>;
  lspCustomServers: LspCustomServer[];
};

export type EditorFormatter =
  | "lsp"
  | "biome"
  | "prettier"
  | "ruff"
  | "rustfmt"
  | "gofmt"
  | "clang-format"
  | "shfmt"
  | "zigfmt"
  | "custom";

export type LspActivation = "enabled" | "dismissed";

export type LspCustomServer = {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** languageResolver id -> LSP languageId */
  languages: Record<string, string>;
  rootMarkers: string[];
};

const STORE_PATH = "terax-settings.json";
const KEY_THEME = "theme";
const KEY_THEME_ID = "themeId";
const KEY_BG_KIND = "backgroundKind";
const KEY_BG_IMAGE_ID = "backgroundImageId";
const KEY_BG_OPACITY = "backgroundOpacity";
const KEY_BG_BLUR = "backgroundBlur";
const KEY_WINDOW_VIBRANCY = "windowVibrancy";
const KEY_DEFAULT_MODEL = "defaultModelId";
const KEY_EDITOR_THEME = "editorTheme";
const KEY_EDITOR_FONT_SIZE = "editorFontSize";
const KEY_CUSTOM_INSTRUCTIONS = "customInstructions";
const KEY_AI_APPROVAL_MODE = "aiApprovalMode";
const KEY_REASONING_EFFORT_BY_MODEL = "reasoningEffortByModel";
const KEY_AUTOSTART = "autostart";
const KEY_RESTORE_WINDOW = "restoreWindowState";
export type AutocompleteTrigger = "auto" | "manual";

const KEY_AUTOCOMPLETE_ENABLED = "autocompleteEnabled";
const KEY_AUTOCOMPLETE_TRIGGER = "autocompleteTrigger";
const KEY_AUTOCOMPLETE_PROVIDER = "autocompleteProvider";
const KEY_AUTOCOMPLETE_MODEL = "autocompleteModelId";
const KEY_LMSTUDIO_BASE_URL = "lmstudioBaseURL";
const KEY_LMSTUDIO_MODEL_ID = "lmstudioModelId";
const KEY_MLX_BASE_URL = "mlxBaseURL";
const KEY_MLX_MODEL_ID = "mlxModelId";
const KEY_OLLAMA_BASE_URL = "ollamaBaseURL";
const KEY_OLLAMA_MODEL_ID = "ollamaModelId";
const KEY_OPENAI_COMPAT_BASE_URL = "openaiCompatibleBaseURL";
const KEY_OPENAI_COMPAT_MODEL_ID = "openaiCompatibleModelId";
const KEY_OPENAI_COMPAT_CONTEXT_LIMIT = "openaiCompatibleContextLimit";
const KEY_CUSTOM_ENDPOINTS = "customEndpoints";
const KEY_OPENROUTER_MODEL_ID = "openrouterModelId";
const KEY_STT_PROVIDER = "sttProvider";
const KEY_GROQ_STT_MODEL = "groqSttModel";
const KEY_WHISPERCPP_BASE_URL = "whispercppBaseURL";
const KEY_FAVORITE_MODELS = "favoriteModelIds";
const KEY_RECENT_MODELS = "recentModelIds";
const KEY_VIM_MODE = "vimMode";
const KEY_EDITOR_WORD_WRAP = "editorWordWrap";
const KEY_EDITOR_WORD_WRAP_COLUMN = "editorWordWrapColumn";
const KEY_DIFF_VIEW_MODE = "diffViewMode";
const KEY_EDITOR_DEFAULT_INDENT = "editorDefaultIndent";
const KEY_SHOW_HIDDEN = "showHidden";
const LEGACY_KEY_SHOW_HIDDEN_DIRS = "showHiddenDirectories";
const KEY_EXPLORER_GIT_DECORATIONS = "explorerGitDecorations";
const KEY_APP_ALL_FOLDERS = "appAllFolders";
const KEY_AI_ALL_FOLDERS = "aiAllFolders";
const KEY_TERMINAL_LINKS_IN_PREVIEW = "terminalLinksInPreview";
const KEY_TERMINAL_RENDERER = "terminalRenderer";
const KEY_TERMINAL_SCREEN_READER = "terminalScreenReader";
const KEY_TERMINAL_CURSOR_BLINK = "terminalCursorBlink";
const KEY_TERMINAL_CURSOR_STYLE = "terminalCursorStyle";
const KEY_TERMINAL_FONT_FAMILY = "terminalFontFamily";
const KEY_TERMINAL_FONT_WEIGHT = "terminalFontWeight";
const KEY_TERMINAL_SHELL = "terminalShell";
const KEY_TERMINAL_LETTER_SPACING = "terminalLetterSpacing";
const KEY_TERMINAL_LINE_HEIGHT = "terminalLineHeight";
const KEY_TERMINAL_FONT_FEATURES = "terminalFontFeatures";
const KEY_TERMINAL_MINIMUM_CONTRAST = "terminalMinimumContrast";
const KEY_TERMINAL_CUSTOM_SHADER = "terminalCustomShader";
const KEY_TERMINAL_LIGATURES = "terminalLigatures";
const KEY_TERMINAL_FONT_SIZE = "terminalFontSize";
const KEY_TERMINAL_SCROLLBACK = "terminalScrollback";
const KEY_TERMINAL_PANE_LIMIT = "terminalPaneLimit";
const KEY_TERMINAL_BEHAVIOR = "terminalBehavior";
const KEY_CONFIRM_CLOSE_RUNNING_TERMINAL = "confirmCloseRunningTerminal";
const KEY_LAST_WSL_DISTRO = "lastWslDistro";
const KEY_MAC_FULL_DISK_ACCESS_SUGGESTED = "macFullDiskAccessSuggested";
const KEY_ZOOM_LEVEL = "zoomLevel";
const KEY_AGENT_NOTIFICATIONS = "agentNotifications";
const KEY_AGENT_NOTIFICATION_SOUND = "agentNotificationSound";
const KEY_AGENT_LAUNCH_COMMANDS = "agentLaunchCommands";
const KEY_DEFAULT_WORKSPACE_ENV = "defaultWorkspaceEnv";
const KEY_SHORTCUTS = "shortcuts";
const KEY_EDITOR_AUTO_SAVE = "editorAutoSave";
const KEY_EDITOR_AUTO_SAVE_DELAY = "editorAutoSaveDelay";
const KEY_EDITOR_FORMAT_ON_SAVE = "editorFormatOnSave";
const KEY_EDITOR_FORMATTER = "editorFormatter";
const KEY_EDITOR_FORMATTER_BY_LANG = "editorFormatterByLang";
const KEY_EDITOR_CUSTOM_FORMAT_COMMAND = "editorCustomFormatCommand";
const KEY_LSP_ACTIVATION = "lspActivation";
const KEY_LSP_CUSTOM_SERVERS = "lspCustomServers";

const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_LINE_HEIGHT_DEFAULT = 1.2;
export const TERMINAL_LINE_HEIGHTS = [
  1, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.8, 2,
] as const;

/** A stored feature list, or "" when it is not one `parseFontFeatures` takes. */
export function normalizeTerminalFontFeatures(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024) return "";
  const trimmed = value.trim();
  return parseFontFeatures(trimmed).error === null ? trimmed : "";
}

export function clampTerminalLineHeight(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(2, Math.max(1, Math.round(value * 100) / 100))
    : TERMINAL_LINE_HEIGHT_DEFAULT;
}
/** Off, then WCAG's thresholds: large text, AA, AAA. */
export const TERMINAL_MINIMUM_CONTRASTS = [1, 1.5, 3, 4.5, 7] as const;

export type TerminalCustomShader = {
  /** The file it came from, for display. */
  readonly name: string;
  readonly source: string;
};

/** Ghostty's shaders are a few KiB; the WebGL renderer refuses more. */
export const TERMINAL_CUSTOM_SHADER_MAX_BYTES = 256 * 1024;

export function normalizeTerminalCustomShader(
  value: unknown,
): TerminalCustomShader | null {
  if (!value || typeof value !== "object") return null;
  const { name, source } = value as Record<string, unknown>;
  if (typeof source !== "string" || source.trim() === "") return null;
  if (source.length > TERMINAL_CUSTOM_SHADER_MAX_BYTES) return null;
  return {
    name: typeof name === "string" && name ? name.slice(0, 200) : "shader",
    source,
  };
}

/** A WCAG contrast ratio, 1 (off) to 21. */
export function clampMinimumContrast(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(21, Math.max(1, value))
    : 1;
}

/** On unless explicitly turned off. */
export function coerceTerminalLigatures(value: unknown): boolean {
  return value !== false;
}

const TERMINAL_FONT_SIZE_MIN = 8;
const TERMINAL_FONT_SIZE_MAX = 32;

export const TERMINAL_FONT_SIZES = [
  10, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const EDITOR_FONT_SIZE_DEFAULT = 13;
export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_FONT_SIZES = [
  10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const EDITOR_WORD_WRAP_COLUMN_DEFAULT = 80;
export const EDITOR_WORD_WRAP_COLUMN_MIN = 20;
export const EDITOR_WORD_WRAP_COLUMN_MAX = 500;

// Ghostty keeps about 10 MB of history per terminal; the global budget in
// scrollbackBudget.ts bounds the total across terminals.
const TERMINAL_SCROLLBACK_DEFAULT = 10_000;
const TERMINAL_SCROLLBACK_MIN = 200;
const TERMINAL_SCROLLBACK_MAX = 100_000;
export const TERMINAL_SCROLLBACK_PRESETS = [
  1000, 2000, 5000, 10_000, 25_000, 50_000, 100_000,
] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  themeId: DEFAULT_THEME_ID,
  backgroundKind: "none",
  backgroundImageId: null,
  backgroundOpacity: 0.5,
  backgroundBlur: 0,
  defaultModelId: DEFAULT_MODEL_ID,
  editorTheme: EDITOR_THEME_AUTO,
  editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  customInstructions: "",
  aiApprovalMode: "ask",
  reasoningEffortByModel: {},
  autostart: false,
  // Off by default: a translucent window keeps the compositor blending the
  // whole frame every present. An explicitly stored choice (either value)
  // always wins; only an absent key falls back to this.
  windowVibrancy: false,
  restoreWindowState: true,
  autocompleteEnabled: false,
  autocompleteTrigger: "auto",
  autocompleteProvider: "cerebras",
  autocompleteModelId: DEFAULT_AUTOCOMPLETE_MODEL.cerebras ?? "",
  lmstudioBaseURL: LMSTUDIO_DEFAULT_BASE_URL,
  lmstudioModelId: "",
  mlxBaseURL: MLX_DEFAULT_BASE_URL,
  mlxModelId: "",
  ollamaBaseURL: OLLAMA_DEFAULT_BASE_URL,
  ollamaModelId: "",
  openaiCompatibleBaseURL: OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  openaiCompatibleModelId: "",
  openaiCompatibleContextLimit: 128_000,
  customEndpoints: [],
  openrouterModelId: "",
  sttProvider: DEFAULT_STT_PROVIDER,
  groqSttModel: "whisper-large-v3-turbo",
  whispercppBaseURL: WHISPERCPP_DEFAULT_BASE_URL,
  favoriteModelIds: [],
  recentModelIds: [],
  vimMode: false,
  editorWordWrap: false,
  editorWordWrapColumn: EDITOR_WORD_WRAP_COLUMN_DEFAULT,
  diffViewMode: "inline",
  editorDefaultIndent: "spaces2",
  showHidden: false,
  explorerGitDecorations: true,
  appAllFolders: false,
  aiAllFolders: false,
  terminalLinksInPreview: false,
  terminalRenderer: "auto",
  terminalScreenReader: false,
  terminalCursorBlink: false,
  terminalCursorStyle: "bar",
  terminalFontFamily: "",
  terminalFontWeight: "normal",
  terminalShell: "",
  terminalLetterSpacing: 0,
  terminalLineHeight: TERMINAL_LINE_HEIGHT_DEFAULT,
  terminalFontFeatures: "",
  terminalMinimumContrast: 1,
  terminalCustomShader: null,
  terminalLigatures: true,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalScrollback: TERMINAL_SCROLLBACK_DEFAULT,
  terminalPaneLimit: MAX_PANES_PER_TAB,
  terminalBehavior: defaultTerminalBehavior(currentPlatform()),
  confirmCloseRunningTerminal: true,
  lastWslDistro: null,
  zoomLevel: 1.0,
  agentNotifications: true,
  agentNotificationSound: true,
  agentLaunchCommands: DEFAULT_AGENT_LAUNCH_COMMANDS,
  defaultWorkspaceEnv: "local",
  shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  editorAutoSave: false,
  editorAutoSaveDelay: 1000,
  editorFormatOnSave: false,
  editorFormatter: "lsp",
  editorFormatterByLang: {},
  editorCustomFormatCommand: "",
  lspActivation: {},
  lspCustomServers: [],
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

// LazyStore.onChange only fires within the writing process. The settings
// page lives in a separate webview, so writes there never reach the main
// window's subscribers. Mirror every setter through a Tauri event so any
// window can listen.
const PREFS_CHANGED_EVENT = "terax://prefs-changed";

async function writePref<T>(key: string, value: T): Promise<void> {
  await store.set(key, value);
  await store.save();
  await emit(PREFS_CHANGED_EVENT, { key, value });
}

export async function loadPreferences(): Promise<Preferences> {
  // Single IPC roundtrip — fetching keys individually fans out to one
  // `plugin:store|get` per setting and is the dominant boot cost.
  const entries = await store.entries();
  const map = new Map<string, unknown>(entries);
  const get = <T>(k: string): T | undefined => map.get(k) as T | undefined;
  // An empty saved list means the user removed every endpoint; only a list
  // never saved is migrated from the legacy single endpoint.
  const customEndpoints =
    get<CustomEndpoint[]>(KEY_CUSTOM_ENDPOINTS) ??
    migrateLegacyCompatEndpoint(
      get<string>(KEY_OPENAI_COMPAT_BASE_URL) ?? "",
      get<string>(KEY_OPENAI_COMPAT_MODEL_ID) ?? "",
      get<number>(KEY_OPENAI_COMPAT_CONTEXT_LIMIT) ?? 128_000,
    );
  // Ids of deleted or unfinished endpoints are dropped; the rest, custom
  // endpoints included, survive a restart.
  const usable = (id: string) => isResolvableModelId(id, customEndpoints);
  return {
    theme: get<ThemePref>(KEY_THEME) ?? DEFAULT_PREFERENCES.theme,
    themeId: get<string>(KEY_THEME_ID) ?? DEFAULT_PREFERENCES.themeId,
    backgroundKind:
      get<BackgroundKind>(KEY_BG_KIND) ?? DEFAULT_PREFERENCES.backgroundKind,
    backgroundImageId:
      get<string | null>(KEY_BG_IMAGE_ID) ??
      DEFAULT_PREFERENCES.backgroundImageId,
    backgroundOpacity: clampBgOpacity(
      get<number>(KEY_BG_OPACITY) ?? DEFAULT_PREFERENCES.backgroundOpacity,
    ),
    backgroundBlur: clampBlur(
      get<number>(KEY_BG_BLUR) ?? DEFAULT_PREFERENCES.backgroundBlur,
    ),
    defaultModelId: ((): string => {
      const stored = get<string>(KEY_DEFAULT_MODEL);
      return stored && usable(stored)
        ? stored
        : DEFAULT_PREFERENCES.defaultModelId;
    })(),
    editorTheme: ((): EditorThemePref => {
      const stored = get<string>(KEY_EDITOR_THEME);
      if (stored === EDITOR_THEME_AUTO || isEditorThemeId(stored))
        return stored;
      return DEFAULT_PREFERENCES.editorTheme;
    })(),
    editorFontSize: clampEditorFontSize(
      get<number>(KEY_EDITOR_FONT_SIZE) ?? DEFAULT_PREFERENCES.editorFontSize,
    ),
    customInstructions:
      get<string>(KEY_CUSTOM_INSTRUCTIONS) ??
      DEFAULT_PREFERENCES.customInstructions,
    aiApprovalMode: normalizeApprovalMode(get<unknown>(KEY_AI_APPROVAL_MODE)),
    reasoningEffortByModel: normalizeReasoningEffortByModel(
      get<unknown>(KEY_REASONING_EFFORT_BY_MODEL),
    ),
    autostart: get<boolean>(KEY_AUTOSTART) ?? DEFAULT_PREFERENCES.autostart,
    restoreWindowState:
      get<boolean>(KEY_RESTORE_WINDOW) ??
      DEFAULT_PREFERENCES.restoreWindowState,
    windowVibrancy:
      get<boolean>(KEY_WINDOW_VIBRANCY) ?? DEFAULT_PREFERENCES.windowVibrancy,
    autocompleteEnabled:
      get<boolean>(KEY_AUTOCOMPLETE_ENABLED) ??
      DEFAULT_PREFERENCES.autocompleteEnabled,
    autocompleteTrigger:
      get<AutocompleteTrigger>(KEY_AUTOCOMPLETE_TRIGGER) ??
      DEFAULT_PREFERENCES.autocompleteTrigger,
    autocompleteProvider:
      get<AutocompleteProviderId>(KEY_AUTOCOMPLETE_PROVIDER) ??
      DEFAULT_PREFERENCES.autocompleteProvider,
    autocompleteModelId:
      get<string>(KEY_AUTOCOMPLETE_MODEL) ??
      DEFAULT_PREFERENCES.autocompleteModelId,
    lmstudioBaseURL:
      get<string>(KEY_LMSTUDIO_BASE_URL) ?? DEFAULT_PREFERENCES.lmstudioBaseURL,
    lmstudioModelId:
      get<string>(KEY_LMSTUDIO_MODEL_ID) ?? DEFAULT_PREFERENCES.lmstudioModelId,
    mlxBaseURL: get<string>(KEY_MLX_BASE_URL) ?? DEFAULT_PREFERENCES.mlxBaseURL,
    mlxModelId: get<string>(KEY_MLX_MODEL_ID) ?? DEFAULT_PREFERENCES.mlxModelId,
    ollamaBaseURL:
      get<string>(KEY_OLLAMA_BASE_URL) ?? DEFAULT_PREFERENCES.ollamaBaseURL,
    ollamaModelId:
      get<string>(KEY_OLLAMA_MODEL_ID) ?? DEFAULT_PREFERENCES.ollamaModelId,
    openaiCompatibleBaseURL:
      get<string>(KEY_OPENAI_COMPAT_BASE_URL) ??
      DEFAULT_PREFERENCES.openaiCompatibleBaseURL,
    openaiCompatibleModelId:
      get<string>(KEY_OPENAI_COMPAT_MODEL_ID) ??
      DEFAULT_PREFERENCES.openaiCompatibleModelId,
    openaiCompatibleContextLimit:
      get<number>(KEY_OPENAI_COMPAT_CONTEXT_LIMIT) ??
      DEFAULT_PREFERENCES.openaiCompatibleContextLimit,
    customEndpoints,
    openrouterModelId:
      get<string>(KEY_OPENROUTER_MODEL_ID) ??
      DEFAULT_PREFERENCES.openrouterModelId,
    sttProvider:
      get<SttProvider>(KEY_STT_PROVIDER) ?? DEFAULT_PREFERENCES.sttProvider,
    groqSttModel:
      get<string>(KEY_GROQ_STT_MODEL) ?? DEFAULT_PREFERENCES.groqSttModel,
    whispercppBaseURL:
      get<string>(KEY_WHISPERCPP_BASE_URL) ??
      DEFAULT_PREFERENCES.whispercppBaseURL,
    favoriteModelIds: (
      get<string[]>(KEY_FAVORITE_MODELS) ?? DEFAULT_PREFERENCES.favoriteModelIds
    ).filter(usable),
    recentModelIds: (
      get<string[]>(KEY_RECENT_MODELS) ?? DEFAULT_PREFERENCES.recentModelIds
    ).filter(usable),
    vimMode: get<boolean>(KEY_VIM_MODE) ?? DEFAULT_PREFERENCES.vimMode,
    editorWordWrap:
      get<boolean>(KEY_EDITOR_WORD_WRAP) ?? DEFAULT_PREFERENCES.editorWordWrap,
    editorWordWrapColumn: clampEditorWordWrapColumn(
      get<number>(KEY_EDITOR_WORD_WRAP_COLUMN) ??
        DEFAULT_PREFERENCES.editorWordWrapColumn,
    ),
    diffViewMode: parseDiffViewMode(get<unknown>(KEY_DIFF_VIEW_MODE)),
    editorDefaultIndent: parseEditorDefaultIndent(
      get<unknown>(KEY_EDITOR_DEFAULT_INDENT),
    ),
    showHidden:
      get<boolean>(KEY_SHOW_HIDDEN) ??
      get<boolean>(LEGACY_KEY_SHOW_HIDDEN_DIRS) ??
      DEFAULT_PREFERENCES.showHidden,
    explorerGitDecorations:
      get<boolean>(KEY_EXPLORER_GIT_DECORATIONS) ??
      DEFAULT_PREFERENCES.explorerGitDecorations,
    // Only a stored `true` widens access; anything else is the default, off.
    appAllFolders: get<unknown>(KEY_APP_ALL_FOLDERS) === true,
    aiAllFolders: get<unknown>(KEY_AI_ALL_FOLDERS) === true,
    terminalLinksInPreview:
      get<boolean>(KEY_TERMINAL_LINKS_IN_PREVIEW) ??
      DEFAULT_PREFERENCES.terminalLinksInPreview,
    terminalRenderer:
      get<string>(KEY_TERMINAL_RENDERER) === "webgl" ? "webgl" : "auto",
    terminalScreenReader: get<boolean>(KEY_TERMINAL_SCREEN_READER) === true,
    terminalCursorBlink:
      get<boolean>(KEY_TERMINAL_CURSOR_BLINK) ??
      DEFAULT_PREFERENCES.terminalCursorBlink,
    terminalCursorStyle: coerceTerminalCursorStyle(
      get<unknown>(KEY_TERMINAL_CURSOR_STYLE),
    ),
    terminalFontFamily:
      get<string>(KEY_TERMINAL_FONT_FAMILY) ??
      DEFAULT_PREFERENCES.terminalFontFamily,
    terminalFontWeight: coerceFontWeight(
      get<string>(KEY_TERMINAL_FONT_WEIGHT) ??
        DEFAULT_PREFERENCES.terminalFontWeight,
    ),
    terminalShell:
      get<string>(KEY_TERMINAL_SHELL) ?? DEFAULT_PREFERENCES.terminalShell,
    terminalLetterSpacing:
      get<number>(KEY_TERMINAL_LETTER_SPACING) ??
      DEFAULT_PREFERENCES.terminalLetterSpacing,
    terminalLineHeight: clampTerminalLineHeight(
      get<number>(KEY_TERMINAL_LINE_HEIGHT),
    ),
    terminalFontFeatures: normalizeTerminalFontFeatures(
      get<unknown>(KEY_TERMINAL_FONT_FEATURES),
    ),
    terminalMinimumContrast: clampMinimumContrast(
      get<number>(KEY_TERMINAL_MINIMUM_CONTRAST),
    ),
    terminalCustomShader: normalizeTerminalCustomShader(
      get<unknown>(KEY_TERMINAL_CUSTOM_SHADER),
    ),
    terminalLigatures: coerceTerminalLigatures(
      get<unknown>(KEY_TERMINAL_LIGATURES),
    ),
    terminalFontSize:
      get<number>(KEY_TERMINAL_FONT_SIZE) ??
      DEFAULT_PREFERENCES.terminalFontSize,
    terminalScrollback: clampScrollback(
      get<number>(KEY_TERMINAL_SCROLLBACK) ??
        DEFAULT_PREFERENCES.terminalScrollback,
    ),
    terminalPaneLimit: clampPaneLimit(get<unknown>(KEY_TERMINAL_PANE_LIMIT)),
    terminalBehavior: normalizeTerminalBehavior(
      get<unknown>(KEY_TERMINAL_BEHAVIOR),
      DEFAULT_PREFERENCES.terminalBehavior,
    ),
    confirmCloseRunningTerminal:
      get<boolean>(KEY_CONFIRM_CLOSE_RUNNING_TERMINAL) ??
      DEFAULT_PREFERENCES.confirmCloseRunningTerminal,
    lastWslDistro:
      get<string | null>(KEY_LAST_WSL_DISTRO) ??
      DEFAULT_PREFERENCES.lastWslDistro,
    zoomLevel: get<number>(KEY_ZOOM_LEVEL) ?? DEFAULT_PREFERENCES.zoomLevel,
    agentNotifications:
      get<boolean>(KEY_AGENT_NOTIFICATIONS) ??
      DEFAULT_PREFERENCES.agentNotifications,
    agentNotificationSound:
      get<boolean>(KEY_AGENT_NOTIFICATION_SOUND) ??
      DEFAULT_PREFERENCES.agentNotificationSound,
    agentLaunchCommands: normalizeAgentLaunchCommands(
      get<unknown>(KEY_AGENT_LAUNCH_COMMANDS),
    ),
    defaultWorkspaceEnv:
      get<string>(KEY_DEFAULT_WORKSPACE_ENV) ??
      DEFAULT_PREFERENCES.defaultWorkspaceEnv,
    shortcuts:
      get<Record<ShortcutId, KeyBinding[]>>(KEY_SHORTCUTS) ??
      DEFAULT_PREFERENCES.shortcuts,
    editorAutoSave:
      get<boolean>(KEY_EDITOR_AUTO_SAVE) ?? DEFAULT_PREFERENCES.editorAutoSave,
    editorAutoSaveDelay: clampAutoSaveDelay(
      get<number>(KEY_EDITOR_AUTO_SAVE_DELAY) ??
        DEFAULT_PREFERENCES.editorAutoSaveDelay,
    ),
    editorFormatOnSave:
      get<boolean>(KEY_EDITOR_FORMAT_ON_SAVE) ??
      DEFAULT_PREFERENCES.editorFormatOnSave,
    editorFormatter:
      get<EditorFormatter>(KEY_EDITOR_FORMATTER) ??
      DEFAULT_PREFERENCES.editorFormatter,
    editorFormatterByLang:
      get<Record<string, EditorFormatter>>(KEY_EDITOR_FORMATTER_BY_LANG) ??
      DEFAULT_PREFERENCES.editorFormatterByLang,
    editorCustomFormatCommand:
      get<string>(KEY_EDITOR_CUSTOM_FORMAT_COMMAND) ??
      DEFAULT_PREFERENCES.editorCustomFormatCommand,
    lspActivation:
      get<Record<string, LspActivation>>(KEY_LSP_ACTIVATION) ??
      DEFAULT_PREFERENCES.lspActivation,
    lspCustomServers:
      get<LspCustomServer[]>(KEY_LSP_CUSTOM_SERVERS) ??
      DEFAULT_PREFERENCES.lspCustomServers,
  };
}

export async function setLspActivation(
  id: string,
  value: LspActivation | null,
): Promise<void> {
  const current =
    ((await store.get(KEY_LSP_ACTIVATION)) as Record<string, LspActivation>) ??
    {};
  const next = { ...current };
  if (value === null) delete next[id];
  else next[id] = value;
  await writePref(KEY_LSP_ACTIVATION, next);
}

export async function setLspCustomServers(
  value: LspCustomServer[],
): Promise<void> {
  await writePref(KEY_LSP_CUSTOM_SERVERS, value);
}

export async function setTheme(value: ThemePref): Promise<void> {
  await writePref(KEY_THEME, value);
}

export async function setThemeId(value: string): Promise<void> {
  await writePref(KEY_THEME_ID, value);
}

/** Slider stores 0..1. Actual rendered opacity is halved in SurfaceLayer
 *  so the image never exceeds 50% — keeps UI/terminal readable at any setting. */
export const BG_OPACITY_RENDER_FACTOR = 0.5;

function clampBgOpacity(v: number): number {
  if (!Number.isFinite(v)) return 0.7;
  return Math.min(1, Math.max(0, v));
}

function clampBlur(v: number): number {
  if (!Number.isFinite(v)) return 16;
  return Math.min(64, Math.max(0, Math.round(v)));
}

export async function setBackgroundKind(value: BackgroundKind): Promise<void> {
  await writePref(KEY_BG_KIND, value);
}

export async function setBackgroundImageId(
  value: string | null,
): Promise<void> {
  await writePref(KEY_BG_IMAGE_ID, value);
}

export async function setBackgroundOpacity(value: number): Promise<void> {
  await writePref(KEY_BG_OPACITY, clampBgOpacity(value));
}

export async function setBackgroundBlur(value: number): Promise<void> {
  await writePref(KEY_BG_BLUR, clampBlur(value));
}

export async function setDefaultModel(value: string): Promise<void> {
  await writePref(KEY_DEFAULT_MODEL, value);
}

export async function setEditorTheme(value: EditorThemePref): Promise<void> {
  await writePref(KEY_EDITOR_THEME, value);
}

export function clampEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_FONT_SIZE_DEFAULT;
  return Math.min(
    EDITOR_FONT_SIZE_MAX,
    Math.max(EDITOR_FONT_SIZE_MIN, Math.round(value)),
  );
}

export async function setEditorFontSize(value: number): Promise<void> {
  await writePref(KEY_EDITOR_FONT_SIZE, clampEditorFontSize(value));
}

export async function setCustomInstructions(value: string): Promise<void> {
  await writePref(KEY_CUSTOM_INSTRUCTIONS, value);
}

export async function setAiApprovalMode(value: ApprovalMode): Promise<void> {
  await writePref(KEY_AI_APPROVAL_MODE, normalizeApprovalMode(value));
}

export async function setReasoningEffortByModel(
  value: Record<string, ReasoningEffort>,
): Promise<void> {
  await writePref(
    KEY_REASONING_EFFORT_BY_MODEL,
    normalizeReasoningEffortByModel(value),
  );
}

export async function setAutostart(value: boolean): Promise<void> {
  await writePref(KEY_AUTOSTART, value);
}

export async function setRestoreWindowState(value: boolean): Promise<void> {
  await writePref(KEY_RESTORE_WINDOW, value);
}

export async function setWindowVibrancy(value: boolean): Promise<void> {
  await writePref(KEY_WINDOW_VIBRANCY, value);
}

export async function setAutocompleteTrigger(
  value: AutocompleteTrigger,
): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_TRIGGER, value);
}

export async function setAutocompleteEnabled(value: boolean): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_ENABLED, value);
}

export async function setAutocompleteProvider(
  value: AutocompleteProviderId,
): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_PROVIDER, value);
}

export async function setAutocompleteModelId(value: string): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_MODEL, value);
}

export async function setLmstudioBaseURL(value: string): Promise<void> {
  await writePref(KEY_LMSTUDIO_BASE_URL, value);
}

export async function setLmstudioModelId(value: string): Promise<void> {
  await writePref(KEY_LMSTUDIO_MODEL_ID, value);
}

export async function setMlxBaseURL(value: string): Promise<void> {
  await writePref(KEY_MLX_BASE_URL, value);
}

export async function setMlxModelId(value: string): Promise<void> {
  await writePref(KEY_MLX_MODEL_ID, value);
}

export async function setOllamaBaseURL(value: string): Promise<void> {
  await writePref(KEY_OLLAMA_BASE_URL, value);
}

export async function setOllamaModelId(value: string): Promise<void> {
  await writePref(KEY_OLLAMA_MODEL_ID, value);
}

export async function setOpenaiCompatibleBaseURL(value: string): Promise<void> {
  await writePref(KEY_OPENAI_COMPAT_BASE_URL, value);
}

export async function setOpenaiCompatibleModelId(value: string): Promise<void> {
  await writePref(KEY_OPENAI_COMPAT_MODEL_ID, value);
}

export async function setOpenaiCompatibleContextLimit(
  value: number,
): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(1_000, Math.round(value))
    : DEFAULT_PREFERENCES.openaiCompatibleContextLimit;
  await writePref(KEY_OPENAI_COMPAT_CONTEXT_LIMIT, clamped);
}

export async function setCustomEndpoints(
  value: CustomEndpoint[],
): Promise<void> {
  await writePref(KEY_CUSTOM_ENDPOINTS, value);
}

export async function setOpenrouterModelId(value: string): Promise<void> {
  await writePref(KEY_OPENROUTER_MODEL_ID, value);
}

export async function setSttProvider(value: SttProvider): Promise<void> {
  await writePref(KEY_STT_PROVIDER, value);
}

export async function setGroqSttModel(value: string): Promise<void> {
  await writePref(KEY_GROQ_STT_MODEL, value.trim());
}

export async function setWhispercppBaseURL(value: string): Promise<void> {
  await writePref(KEY_WHISPERCPP_BASE_URL, value.trim());
}

export async function setFavoriteModelIds(value: string[]): Promise<void> {
  await writePref(KEY_FAVORITE_MODELS, value);
}

export async function setRecentModelIds(value: string[]): Promise<void> {
  await writePref(KEY_RECENT_MODELS, value);
}

export async function setVimMode(value: boolean): Promise<void> {
  await writePref(KEY_VIM_MODE, value);
}

export type DiffViewMode = "inline" | "split";

export function parseDiffViewMode(value: unknown): DiffViewMode {
  return value === "split" ? "split" : "inline";
}

export async function setDiffViewMode(value: DiffViewMode): Promise<void> {
  await writePref(KEY_DIFF_VIEW_MODE, value);
}

export type EditorDefaultIndent = "spaces2" | "spaces4" | "tab";

export function parseEditorDefaultIndent(value: unknown): EditorDefaultIndent {
  return value === "spaces4" || value === "tab" ? value : "spaces2";
}

export async function setEditorDefaultIndent(
  value: EditorDefaultIndent,
): Promise<void> {
  await writePref(KEY_EDITOR_DEFAULT_INDENT, value);
}

export async function setEditorWordWrap(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_WORD_WRAP, value);
}

export function clampEditorWordWrapColumn(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_WORD_WRAP_COLUMN_DEFAULT;
  return Math.min(
    EDITOR_WORD_WRAP_COLUMN_MAX,
    Math.max(EDITOR_WORD_WRAP_COLUMN_MIN, Math.round(value)),
  );
}

export async function setEditorWordWrapColumn(value: number): Promise<void> {
  await writePref(
    KEY_EDITOR_WORD_WRAP_COLUMN,
    clampEditorWordWrapColumn(value),
  );
}

export async function setShowHidden(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_HIDDEN, value);
}

export async function setTerminalLinksInPreview(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_LINKS_IN_PREVIEW, value);
}

export async function setExplorerGitDecorations(value: boolean): Promise<void> {
  await writePref(KEY_EXPLORER_GIT_DECORATIONS, value);
}

export async function setAppAllFolders(value: boolean): Promise<void> {
  await writePref(KEY_APP_ALL_FOLDERS, value === true);
}

export async function setAiAllFolders(value: boolean): Promise<void> {
  await writePref(KEY_AI_ALL_FOLDERS, value === true);
}

export async function setTerminalRenderer(
  value: "auto" | "webgl",
): Promise<void> {
  await writePref(KEY_TERMINAL_RENDERER, value === "webgl" ? "webgl" : "auto");
}

export async function setTerminalScreenReader(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_SCREEN_READER, value);
}

export async function setTerminalCursorBlink(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_BLINK, value);
}

export function coerceTerminalCursorStyle(value: unknown): TerminalCursorStyle {
  return value === "bar" || value === "block" || value === "underline"
    ? value
    : DEFAULT_PREFERENCES.terminalCursorStyle;
}

export async function setTerminalCursorStyle(value: unknown): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_STYLE, coerceTerminalCursorStyle(value));
}

export async function setTerminalFontFamily(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_FAMILY, value.trim());
}

const TERMINAL_FONT_WEIGHT_VALUES = new Set(["normal", "500", "600", "bold"]);

export function coerceFontWeight(value: string): string {
  const v = value.trim();
  return TERMINAL_FONT_WEIGHT_VALUES.has(v) ? v : "normal";
}

export async function setTerminalFontWeight(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_WEIGHT, coerceFontWeight(value));
}

export async function setTerminalShell(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_SHELL, value.trim());
}

export async function setTerminalLetterSpacing(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(-10, Math.min(10, Math.round(value)))
    : 0;
  await writePref(KEY_TERMINAL_LETTER_SPACING, clamped);
}

export async function setTerminalLineHeight(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_LINE_HEIGHT, clampTerminalLineHeight(value));
}

/** Stores a feature list `parseFontFeatures` accepts; others clear it. */
export async function setTerminalFontFeatures(value: string): Promise<void> {
  await writePref(
    KEY_TERMINAL_FONT_FEATURES,
    normalizeTerminalFontFeatures(value),
  );
}

export async function setTerminalCustomShader(
  value: TerminalCustomShader | null,
): Promise<void> {
  await writePref(
    KEY_TERMINAL_CUSTOM_SHADER,
    normalizeTerminalCustomShader(value),
  );
}

export async function setTerminalMinimumContrast(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_MINIMUM_CONTRAST, clampMinimumContrast(value));
}

export async function setTerminalLigatures(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_LIGATURES, coerceTerminalLigatures(value));
}

export async function setTerminalFontSize(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)),
      )
    : TERMINAL_FONT_SIZE_DEFAULT;
  await writePref(KEY_TERMINAL_FONT_SIZE, clamped);
}

function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX,
    Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(value)),
  );
}

export async function setTerminalScrollback(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_SCROLLBACK, clampScrollback(value));
}

export async function setTerminalPaneLimit(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_PANE_LIMIT, clampPaneLimit(value));
}

/** Changes some terminal behaviour switches, keeping the others. */
export async function setTerminalBehavior(
  patch: Partial<TerminalBehavior>,
): Promise<void> {
  const current = normalizeTerminalBehavior(
    await store.get<unknown>(KEY_TERMINAL_BEHAVIOR),
    DEFAULT_PREFERENCES.terminalBehavior,
  );
  await writePref(
    KEY_TERMINAL_BEHAVIOR,
    normalizeTerminalBehavior(
      { ...current, ...patch },
      DEFAULT_PREFERENCES.terminalBehavior,
    ),
  );
}

export async function setConfirmCloseRunningTerminal(
  value: boolean,
): Promise<void> {
  await writePref(KEY_CONFIRM_CLOSE_RUNNING_TERMINAL, value);
}

export async function setLastWslDistro(value: string | null): Promise<void> {
  await writePref(KEY_LAST_WSL_DISTRO, value);
}

/**
 * Whether the first-run notice suggesting Full Disk Access (macOS) has been
 * answered. App state rather than a preference: read once by the main window.
 */
export async function macFullDiskAccessSuggested(): Promise<boolean> {
  return (
    (await store.get<boolean>(KEY_MAC_FULL_DISK_ACCESS_SUGGESTED)) === true
  );
}

export async function setMacFullDiskAccessSuggested(): Promise<void> {
  await store.set(KEY_MAC_FULL_DISK_ACCESS_SUGGESTED, true);
  await store.save();
}

export async function setZoomLevel(value: number): Promise<void> {
  await writePref(KEY_ZOOM_LEVEL, value);
}

export const AUTO_SAVE_DELAY_MIN = 100;
export const AUTO_SAVE_DELAY_MAX = 60000;

export function clampAutoSaveDelay(v: number): number {
  if (!Number.isFinite(v)) return 1000;
  return Math.min(
    AUTO_SAVE_DELAY_MAX,
    Math.max(AUTO_SAVE_DELAY_MIN, Math.round(v)),
  );
}

export async function setEditorAutoSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE, value);
}

export async function setEditorAutoSaveDelay(value: number): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE_DELAY, clampAutoSaveDelay(value));
}

export async function setEditorFormatOnSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_FORMAT_ON_SAVE, value);
}

export async function setEditorFormatter(
  value: EditorFormatter,
): Promise<void> {
  await writePref(KEY_EDITOR_FORMATTER, value);
}

export async function setEditorFormatterByLang(
  value: Record<string, EditorFormatter>,
): Promise<void> {
  await writePref(KEY_EDITOR_FORMATTER_BY_LANG, value);
}

export async function setEditorCustomFormatCommand(
  value: string,
): Promise<void> {
  await writePref(KEY_EDITOR_CUSTOM_FORMAT_COMMAND, value);
}

export async function setAgentNotifications(value: boolean): Promise<void> {
  await writePref(KEY_AGENT_NOTIFICATIONS, value);
}

export async function setAgentNotificationSound(value: boolean): Promise<void> {
  await writePref(KEY_AGENT_NOTIFICATION_SOUND, value);
}

export async function setAgentLaunchCommands(
  value: AgentLaunchCommands,
): Promise<void> {
  await writePref(
    KEY_AGENT_LAUNCH_COMMANDS,
    normalizeAgentLaunchCommands(value),
  );
}

export async function setDefaultWorkspaceEnv(value: string): Promise<void> {
  await writePref(KEY_DEFAULT_WORKSPACE_ENV, value);
}

export async function setShortcuts(
  value: Record<ShortcutId, KeyBinding[]> | {},
): Promise<void> {
  await writePref(KEY_SHORTCUTS, value);
}

export type PrefKey = keyof Preferences;

/** Subscribe to changes from any window (settings → main). */
export async function onPreferencesChange(
  cb: (key: PrefKey, value: unknown) => void,
): Promise<UnlistenFn> {
  const map: Record<string, PrefKey> = {
    [KEY_THEME]: "theme",
    [KEY_THEME_ID]: "themeId",
    [KEY_BG_KIND]: "backgroundKind",
    [KEY_BG_IMAGE_ID]: "backgroundImageId",
    [KEY_BG_OPACITY]: "backgroundOpacity",
    [KEY_BG_BLUR]: "backgroundBlur",
    [KEY_WINDOW_VIBRANCY]: "windowVibrancy",
    [KEY_DEFAULT_MODEL]: "defaultModelId",
    [KEY_EDITOR_THEME]: "editorTheme",
    [KEY_EDITOR_FONT_SIZE]: "editorFontSize",
    [KEY_CUSTOM_INSTRUCTIONS]: "customInstructions",
    [KEY_AI_APPROVAL_MODE]: "aiApprovalMode",
    [KEY_REASONING_EFFORT_BY_MODEL]: "reasoningEffortByModel",
    [KEY_AUTOSTART]: "autostart",
    [KEY_RESTORE_WINDOW]: "restoreWindowState",
    [KEY_AUTOCOMPLETE_ENABLED]: "autocompleteEnabled",
    [KEY_AUTOCOMPLETE_TRIGGER]: "autocompleteTrigger",
    [KEY_AUTOCOMPLETE_PROVIDER]: "autocompleteProvider",
    [KEY_AUTOCOMPLETE_MODEL]: "autocompleteModelId",
    [KEY_LMSTUDIO_BASE_URL]: "lmstudioBaseURL",
    [KEY_LMSTUDIO_MODEL_ID]: "lmstudioModelId",
    [KEY_MLX_BASE_URL]: "mlxBaseURL",
    [KEY_MLX_MODEL_ID]: "mlxModelId",
    [KEY_OLLAMA_BASE_URL]: "ollamaBaseURL",
    [KEY_OLLAMA_MODEL_ID]: "ollamaModelId",
    [KEY_OPENAI_COMPAT_BASE_URL]: "openaiCompatibleBaseURL",
    [KEY_OPENAI_COMPAT_MODEL_ID]: "openaiCompatibleModelId",
    [KEY_OPENAI_COMPAT_CONTEXT_LIMIT]: "openaiCompatibleContextLimit",
    [KEY_CUSTOM_ENDPOINTS]: "customEndpoints",
    [KEY_OPENROUTER_MODEL_ID]: "openrouterModelId",
    [KEY_STT_PROVIDER]: "sttProvider",
    [KEY_GROQ_STT_MODEL]: "groqSttModel",
    [KEY_WHISPERCPP_BASE_URL]: "whispercppBaseURL",
    [KEY_FAVORITE_MODELS]: "favoriteModelIds",
    [KEY_RECENT_MODELS]: "recentModelIds",
    [KEY_VIM_MODE]: "vimMode",
    [KEY_EDITOR_WORD_WRAP]: "editorWordWrap",
    [KEY_EDITOR_WORD_WRAP_COLUMN]: "editorWordWrapColumn",
    [KEY_DIFF_VIEW_MODE]: "diffViewMode",
    [KEY_EDITOR_DEFAULT_INDENT]: "editorDefaultIndent",
    [KEY_SHOW_HIDDEN]: "showHidden",
    [KEY_EXPLORER_GIT_DECORATIONS]: "explorerGitDecorations",
    [KEY_APP_ALL_FOLDERS]: "appAllFolders",
    [KEY_AI_ALL_FOLDERS]: "aiAllFolders",
    [KEY_TERMINAL_LINKS_IN_PREVIEW]: "terminalLinksInPreview",
    [KEY_TERMINAL_RENDERER]: "terminalRenderer",
    [KEY_TERMINAL_SCREEN_READER]: "terminalScreenReader",
    [KEY_TERMINAL_CURSOR_BLINK]: "terminalCursorBlink",
    [KEY_TERMINAL_CURSOR_STYLE]: "terminalCursorStyle",
    [KEY_TERMINAL_FONT_FAMILY]: "terminalFontFamily",
    [KEY_TERMINAL_FONT_WEIGHT]: "terminalFontWeight",
    [KEY_TERMINAL_SHELL]: "terminalShell",
    [KEY_TERMINAL_LETTER_SPACING]: "terminalLetterSpacing",
    [KEY_TERMINAL_LINE_HEIGHT]: "terminalLineHeight",
    [KEY_TERMINAL_FONT_FEATURES]: "terminalFontFeatures",
    [KEY_TERMINAL_MINIMUM_CONTRAST]: "terminalMinimumContrast",
    [KEY_TERMINAL_CUSTOM_SHADER]: "terminalCustomShader",
    [KEY_TERMINAL_LIGATURES]: "terminalLigatures",
    [KEY_TERMINAL_FONT_SIZE]: "terminalFontSize",
    [KEY_TERMINAL_SCROLLBACK]: "terminalScrollback",
    [KEY_TERMINAL_PANE_LIMIT]: "terminalPaneLimit",
    [KEY_TERMINAL_BEHAVIOR]: "terminalBehavior",
    [KEY_CONFIRM_CLOSE_RUNNING_TERMINAL]: "confirmCloseRunningTerminal",
    [KEY_LAST_WSL_DISTRO]: "lastWslDistro",
    [KEY_ZOOM_LEVEL]: "zoomLevel",
    [KEY_AGENT_NOTIFICATIONS]: "agentNotifications",
    [KEY_AGENT_NOTIFICATION_SOUND]: "agentNotificationSound",
    [KEY_AGENT_LAUNCH_COMMANDS]: "agentLaunchCommands",
    [KEY_DEFAULT_WORKSPACE_ENV]: "defaultWorkspaceEnv",
    [KEY_SHORTCUTS]: "shortcuts",
    [KEY_EDITOR_AUTO_SAVE]: "editorAutoSave",
    [KEY_EDITOR_AUTO_SAVE_DELAY]: "editorAutoSaveDelay",
    [KEY_EDITOR_FORMAT_ON_SAVE]: "editorFormatOnSave",
    [KEY_EDITOR_FORMATTER]: "editorFormatter",
    [KEY_EDITOR_FORMATTER_BY_LANG]: "editorFormatterByLang",
    [KEY_EDITOR_CUSTOM_FORMAT_COMMAND]: "editorCustomFormatCommand",
    [KEY_LSP_ACTIVATION]: "lspActivation",
    [KEY_LSP_CUSTOM_SERVERS]: "lspCustomServers",
  };
  // Same-process writes still fire onChange immediately; cross-window writes
  // arrive via the Tauri event emitted by writePref().
  const unsubLocal = await store.onChange<unknown>((key, value) => {
    const mapped = map[key];
    if (mapped) cb(mapped, value);
  });
  const unsubEvent = await listen<{ key: string; value: unknown }>(
    PREFS_CHANGED_EVENT,
    (e) => {
      const mapped = map[e.payload.key];
      if (mapped) cb(mapped, e.payload.value);
    },
  );
  return () => {
    unsubLocal();
    unsubEvent();
  };
}

// API key changes are stored in OS keychain (not the prefs store),
// so we broadcast via a Tauri event for cross-window listeners.
const KEYS_CHANGED_EVENT = "terax://ai-keys-changed";

export async function emitKeysChanged(): Promise<void> {
  await emit(KEYS_CHANGED_EVENT);
}

export function onKeysChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(KEYS_CHANGED_EVENT, () => cb());
}
