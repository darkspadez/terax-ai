import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setTerminalBehavior } from "@/modules/settings/store";
import {
  currentPlatform,
  QUICK_TERMINAL_HOTKEYS,
  type QuickTerminalHotkey,
  type TerminalBehavior,
} from "@/modules/settings/terminalBehavior";
import { SCROLLBACK_MAX_LINES } from "@/modules/terminal/lib/terminalScrollback";
import { SettingRow } from "../components/SettingRow";

type Option<T extends string | number> = {
  readonly value: T;
  readonly label: string;
};

function Choice<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => {
        const option = options.find((entry) => String(entry.value) === next);
        if (option) onChange(option.value);
      }}
    >
      <SelectTrigger size="sm" className="h-8 w-36 text-[12px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={String(option.value)}
            value={String(option.value)}
            className="text-[12px]"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const set = (patch: Partial<TerminalBehavior>) =>
  void setTerminalBehavior(patch);

/** The hotkeys this platform offers, labelled the way it writes them. */
function quickTerminalHotkeyOptions(
  platform: ReturnType<typeof currentPlatform>,
): Option<QuickTerminalHotkey>[] {
  const mac = platform === "macos";
  const labels: Record<QuickTerminalHotkey, string | null> = {
    off: "Off",
    "CommandOrControl+`": mac ? "⌘`" : "Ctrl+`",
    // Same keys as the entry above outside macOS.
    "Control+`": mac ? "⌃`" : null,
    // Alt+Space opens the window menu on Windows.
    "Alt+Space": platform === "windows" ? null : mac ? "⌥Space" : "Alt+Space",
    "CommandOrControl+Shift+Space": mac ? "⇧⌘Space" : "Ctrl+Shift+Space",
    F12: "F12",
  };
  return QUICK_TERMINAL_HOTKEYS.flatMap((value) => {
    const label = labels[value];
    return label === null ? [] : [{ value, label }];
  });
}

/** Terminal input, clipboard and notification behaviour (Ghostty's defaults). */
export function TerminalBehaviorSettings() {
  const behavior = usePreferencesStore((s) => s.terminalBehavior);
  const platform = currentPlatform();

  return (
    <>
      {platform === "macos" && (
        <SettingRow
          title="Option key as Alt"
          description="Which Option key sends Alt (Esc-prefixed, for shells and editors) instead of typing special characters."
        >
          <Choice
            value={behavior.optionAsAlt}
            onChange={(optionAsAlt) => set({ optionAsAlt })}
            options={[
              { value: "off", label: "Neither" },
              { value: "left", label: "Left Option" },
              { value: "right", label: "Right Option" },
              { value: "both", label: "Both" },
            ]}
          />
        </SettingRow>
      )}
      <SettingRow
        title="Copy on select"
        description={
          platform === "linux"
            ? "Selecting text fills the primary selection (pasted with the middle button), and optionally the clipboard."
            : "Copy selected text to the clipboard as soon as the selection ends."
        }
      >
        <Choice
          value={behavior.copyOnSelect}
          onChange={(copyOnSelect) => set({ copyOnSelect })}
          options={
            platform === "linux"
              ? [
                  { value: "off", label: "Off" },
                  { value: "primary", label: "Primary selection" },
                  { value: "clipboard", label: "Clipboard too" },
                ]
              : [
                  { value: "off", label: "Off" },
                  { value: "clipboard", label: "Clipboard" },
                ]
          }
        />
      </SettingRow>
      {platform === "windows" && (
        <SettingRow
          title="Ctrl+C and Ctrl+V copy and paste"
          description="As in Windows Terminal: Ctrl+C copies selected text and interrupts when nothing is selected, Ctrl+V pastes. Ctrl+Shift+C/V, Ctrl+Insert and Shift+Insert work either way."
        >
          <Switch
            checked={behavior.smartCopyPaste}
            onCheckedChange={(smartCopyPaste) => set({ smartCopyPaste })}
          />
        </SettingRow>
      )}
      <SettingRow
        title="Confirm multi-line pastes"
        description="Ask before pasting text with line breaks into a shell that would run it as commands."
      >
        <Switch
          checked={behavior.pasteProtection}
          onCheckedChange={(pasteProtection) => set({ pasteProtection })}
        />
      </SettingRow>
      <SettingRow
        title="Clipboard reads by programs"
        description="Programs can ask to read the clipboard (OSC 52), for example over SSH."
      >
        <Choice
          value={behavior.clipboardRead}
          onChange={(clipboardRead) => set({ clipboardRead })}
          options={[
            { value: "ask", label: "Ask" },
            { value: "allow", label: "Allow" },
            { value: "deny", label: "Deny" },
          ]}
        />
      </SettingRow>
      <SettingRow
        title="Notify when a command finishes"
        description="Desktop notification for commands that ran at least as long as the threshold."
      >
        <div className="flex items-center gap-2">
          <Choice
            value={behavior.notifyAfterSeconds}
            onChange={(notifyAfterSeconds) => set({ notifyAfterSeconds })}
            options={[5, 10, 30, 60, 300].map((seconds) => ({
              value: seconds,
              label:
                seconds < 60 ? `After ${seconds}s` : `After ${seconds / 60}m`,
            }))}
          />
          <Choice
            value={behavior.notifyOnCommandFinish}
            onChange={(notifyOnCommandFinish) => set({ notifyOnCommandFinish })}
            options={[
              { value: "never", label: "Never" },
              { value: "unfocused", label: "When away" },
              { value: "always", label: "Always" },
            ]}
          />
        </div>
      </SettingRow>
      <SettingRow
        title="Program notifications"
        description="Show desktop notifications that programs send (OSC 9 and OSC 777)."
      >
        <Switch
          checked={behavior.desktopNotifications}
          onCheckedChange={(desktopNotifications) =>
            set({ desktopNotifications })
          }
        />
      </SettingRow>
      <SettingRow
        title="Bell sound"
        description="Play a short sound on the terminal bell. A tab that rings out of sight is always marked."
      >
        <Switch
          checked={behavior.bellSound}
          onCheckedChange={(bellSound) => set({ bellSound })}
        />
      </SettingRow>
      <SettingRow
        title="Scroll speed"
        description="Lines per mouse-wheel notch; trackpads scroll by distance, scaled the same way."
      >
        <Choice
          value={behavior.scrollMultiplier}
          onChange={(scrollMultiplier) => set({ scrollMultiplier })}
          options={[1, 2, 3, 5, 8].map((lines) => ({
            value: lines,
            label: `${lines} line${lines === 1 ? "" : "s"}`,
          }))}
        />
      </SettingRow>
      <SettingRow
        title="Restore scrollback after restart"
        description={`Keep each terminal's last ${SCROLLBACK_MAX_LINES.toLocaleString()} lines on this device and show them again when Terax reopens its tabs. Private terminals are never saved; turning this off deletes what was saved.`}
      >
        <Switch
          checked={behavior.restoreScrollback}
          onCheckedChange={(restoreScrollback) => set({ restoreScrollback })}
        />
      </SettingRow>
      <SettingRow
        title="Quick terminal hotkey"
        description="A system-wide key that drops a terminal down from the top of the screen, from any app, and puts it away again."
      >
        <Choice
          value={behavior.quickTerminalHotkey}
          onChange={(quickTerminalHotkey) => set({ quickTerminalHotkey })}
          options={quickTerminalHotkeyOptions(currentPlatform())}
        />
      </SettingRow>
      <SettingRow
        title="Hide the quick terminal when it loses focus"
        description="Otherwise it stays on top until the hotkey is pressed again."
      >
        <Switch
          checked={behavior.quickTerminalAutohide}
          onCheckedChange={(quickTerminalAutohide) =>
            set({ quickTerminalAutohide })
          }
        />
      </SettingRow>
    </>
  );
}
