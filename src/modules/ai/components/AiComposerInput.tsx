import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { usePresence } from "@/lib/usePresence";
import { ensureMcpExtras } from "@/modules/mcp/extras";
import { useMcpExtras } from "@/modules/mcp/lib/extrasCatalog";
import {
  type McpPickerItem,
  mcpPickerSections,
} from "@/modules/mcp/lib/pickerItems";
import {
  matchPromptCommands,
  promptCommands,
} from "@/modules/mcp/lib/promptCommands";
import { useUserSkills } from "@/modules/skills/useUserSkills";
import { BookOpenTextIcon, McpServerIcon } from "@hugeicons/core-free-icons";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useWorkspaceFiles } from "../hooks/useWorkspaceFiles";
import { useComposer } from "../lib/composer";
import { composerKeyAction } from "../lib/composerKeys";
import {
  detectFileTrigger,
  detectSnippetTrigger,
  type FileTrigger,
  type SnippetTrigger,
} from "../lib/composerTriggers";
import {
  pastedImages,
  pasteKeepsText,
  pasteNeedsClipboardImage,
} from "../lib/pastedImages";
import { SLASH_COMMANDS } from "../lib/slashCommands";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import { AgentSwitcher } from "./AgentSwitcher";
import { AllFoldersChip } from "./AllFoldersChip";
import { ApprovalModeControl } from "./ApprovalModeControl";
import { FilePickerContent } from "./FilePicker";
import { SnippetPickerContent, type PickerItem } from "./SnippetPicker";

const McpArgumentsForm = lazy(() =>
  import("@/modules/mcp/components/ArgumentsForm").then((m) => ({
    default: m.McpArgumentsForm,
  })),
);

export function AiComposerInput() {
  const c = useComposer();
  const snippets = useSnippetsStore((s) => s.snippets);
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());

  const [trigger, setTrigger] = useState<SnippetTrigger | null>(null);
  const [fileTrigger, setFileTrigger] = useState<FileTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const workspaceFiles = useWorkspaceFiles(workspaceRoot, fileTrigger !== null);

  const [fileQuery, setFileQuery] = useState("");
  useEffect(() => {
    if (!fileTrigger) {
      setFileQuery("");
      return;
    }
    const q = fileTrigger.query;
    const t = window.setTimeout(() => setFileQuery(q), 50);
    return () => window.clearTimeout(t);
  }, [fileTrigger]);

  useEffect(() => {
    autoresize(c.textareaRef.current);
  }, [c.value, c.textareaRef]);

  const updateTrigger = () => {
    const el = c.textareaRef.current;
    if (!el) {
      setTrigger(null);
      setFileTrigger(null);
      return;
    }
    const caret = el.selectionStart ?? 0;
    setTrigger(detectSnippetTrigger(c.value, caret));
    setFileTrigger(detectFileTrigger(c.value, caret));
  };

  useEffect(updateTrigger, [c.value, c.textareaRef]);

  const skills = useUserSkills(trigger?.char === "/", workspaceRoot);

  // MCP servers start the first time a picker that lists what they offer
  // opens (resources under `@`, prompts under `/`).
  const mcpServers = useMcpExtras((s) => s.servers);
  const mcpStarting = useMcpExtras((s) => s.starting);
  const mcpPickerOpen = fileTrigger !== null || trigger?.char === "/";
  useEffect(() => {
    if (mcpPickerOpen) void ensureMcpExtras();
  }, [mcpPickerOpen]);
  const prompts = useMemo(() => promptCommands(mcpServers), [mcpServers]);

  const filteredItems = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const cmdItems: PickerItem[] = Object.values(SLASH_COMMANDS)
      .filter(
        (c) => !q || c.name.includes(q) || c.label.toLowerCase().includes(q),
      )
      .map((command) => ({ kind: "command", command }));
    if (trigger.char === "/") {
      const skillItems: PickerItem[] = skills
        .filter(
          (skill) =>
            !SLASH_COMMANDS[skill.name] &&
            (!q ||
              skill.name.includes(q) ||
              skill.description.toLowerCase().includes(q)),
        )
        .map((skill) => ({ kind: "skill", skill }));
      const promptItems: PickerItem[] = matchPromptCommands(prompts, q).map(
        (prompt) => ({ kind: "prompt", prompt }),
      );
      return [...cmdItems, ...skillItems, ...promptItems];
    }
    const snipItems: PickerItem[] = snippets
      .filter(
        (s) =>
          !q ||
          s.handle.includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
      .map((snippet) => ({ kind: "snippet", snippet }));
    return [...cmdItems, ...snipItems];
  }, [trigger, snippets, skills, prompts]);

  const FILE_PICKER_CAP = 30;
  const filteredFiles = useMemo<string[]>(() => {
    if (!fileTrigger) return [];
    const q = fileQuery.toLowerCase();
    if (!q) return workspaceFiles.files.slice(0, FILE_PICKER_CAP);
    const out: string[] = [];
    for (const f of workspaceFiles.files) {
      if (f.toLowerCase().includes(q)) {
        out.push(f);
        if (out.length >= FILE_PICKER_CAP) break;
      }
    }
    return out;
  }, [fileTrigger, fileQuery, workspaceFiles.files]);

  const mcpSections = useMemo(
    () => (fileTrigger ? mcpPickerSections(mcpServers, fileQuery) : []),
    [fileTrigger, fileQuery, mcpServers],
  );
  const mcpItems = useMemo(
    () => mcpSections.flatMap((section) => section.items),
    [mcpSections],
  );
  const atItemCount = filteredFiles.length + mcpItems.length;

  const fileTriggerOpen = fileTrigger !== null;
  const snippetTriggerOpen = trigger !== null;
  useEffect(() => {
    setActiveIndex(0);
  }, [snippetTriggerOpen, fileTriggerOpen, fileQuery]);

  const mcpForm = c.mcpForm;
  const pickerOpen =
    mcpForm !== null || trigger !== null || fileTrigger !== null;

  const onPickItem = (item: PickerItem) => {
    if (!trigger) return;
    const before = c.value.slice(0, trigger.start);
    const afterRaw = c.value.slice(trigger.end);
    let insert = "";
    if (item.kind === "snippet") {
      const needsSpace = afterRaw.length === 0 || !/^\s/.test(afterRaw);
      insert = `#${item.snippet.handle}${needsSpace ? " " : ""}`;
      c.addSnippet(item.snippet);
    } else if (item.kind === "skill") {
      c.addCommand({
        name: item.skill.name,
        invocation: `/${item.skill.name}`,
        label: item.skill.description,
        icon: BookOpenTextIcon,
        skill: true,
      });
    } else if (item.kind === "prompt") {
      const { prompt } = item;
      c.addCommand({
        name: prompt.command,
        invocation: `/${prompt.command}`,
        label: `${prompt.prompt.title ?? prompt.prompt.name}, a prompt of the MCP server ${prompt.serverName}`,
        icon: McpServerIcon,
        prompt: true,
      });
    } else {
      c.addCommand(item.command);
    }
    const after =
      item.kind === "snippet" ? afterRaw : afterRaw.replace(/^\s+/, "");
    c.setValue(`${before}${insert}${after}`);
    setTrigger(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      const caret = before.length + insert.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const onPickFile = async (filePath: string) => {
    if (!fileTrigger || !workspaceRoot) return;
    const before = c.value.slice(0, fileTrigger.start);
    const after = c.value.slice(fileTrigger.end);
    c.setValue(`${before}${after}`);
    setFileTrigger(null);
    setActiveIndex(0);
    const fullPath = workspaceRoot.endsWith("/")
      ? `${workspaceRoot}${filePath}`
      : `${workspaceRoot}/${filePath}`;
    await c.attachFileByPath(fullPath);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  /** A resource is read and attached; a template opens its form first. */
  const onPickMcp = async (item: McpPickerItem) => {
    if (!fileTrigger) return;
    const before = c.value.slice(0, fileTrigger.start);
    const after = c.value.slice(fileTrigger.end);
    c.setValue(`${before}${after}`);
    setFileTrigger(null);
    setActiveIndex(0);
    const refocus = () =>
      requestAnimationFrame(() => {
        const el = c.textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(before.length, before.length);
      });
    const label =
      item.kind === "resource"
        ? (item.resource.title ?? item.resource.name)
        : (item.template.title ?? item.template.name);
    try {
      const { resourceFiles, templateForm } = await import(
        "@/modules/mcp/composer"
      );
      const attach = ({
        files,
        refused,
      }: {
        files: Parameters<typeof c.attachFiles>[0];
        refused: string[];
      }) => {
        c.attachFiles(files);
        if (refused.length > 0) {
          toast.error(
            files.length > 0
              ? `Part of ${label} was not attached`
              : `Could not attach ${label}`,
            { description: refused.join(" ") },
          );
        }
      };
      if (item.kind === "resource") {
        attach(
          await resourceFiles(item.serverId, item.serverName, {
            uri: item.resource.uri,
            name: label,
          }),
        );
        refocus();
        return;
      }
      c.setMcpForm(
        templateForm(
          item,
          (files) => {
            c.setMcpForm(null);
            attach(files);
            refocus();
          },
          () => {
            c.setMcpForm(null);
            refocus();
          },
        ),
      );
    } catch (e) {
      toast.error(`Could not attach ${label}`, {
        description: e instanceof Error ? e.message : String(e),
      });
      refocus();
    }
  };

  const pickActive = () => {
    if (fileTrigger) {
      const file = filteredFiles[activeIndex];
      if (file) {
        void onPickFile(file);
        return;
      }
      const mcp = mcpItems[activeIndex - filteredFiles.length];
      if (mcp) void onPickMcp(mcp);
      return;
    }
    const it = filteredItems[activeIndex];
    if (it) onPickItem(it);
  };

  const middlePressAt = useRef(Number.NEGATIVE_INFINITY);

  const voiceLabel = c.voice.recording
    ? "Listening…"
    : c.voice.transcribing
      ? "Transcribing…"
      : null;
  const voiceRow = usePresence(Boolean(voiceLabel), 180);
  const lastVoiceLabel = useRef("");
  if (voiceLabel) lastVoiceLabel.current = voiceLabel;

  return (
    <>
      <Popover open={pickerOpen}>
        <PopoverAnchor asChild>
          <div className="flex items-start gap-2">
            <textarea
              ref={c.textareaRef}
              value={c.value}
              onChange={(e) => c.setValue(e.target.value)}
              onKeyUp={updateTrigger}
              onClick={updateTrigger}
              onSelect={updateTrigger}
              onMouseDown={(e) => {
                if (e.button === 1) middlePressAt.current = e.timeStamp;
              }}
              onPaste={(e) => {
                const images = pastedImages(e.clipboardData);
                if (images.length > 0) {
                  if (!pasteKeepsText(e.clipboardData)) e.preventDefault();
                  void c.addFiles(images);
                  return;
                }
                // A middle click pastes the primary selection, not the clipboard.
                const fromPrimary = e.timeStamp - middlePressAt.current < 1000;
                if (pasteNeedsClipboardImage(e.clipboardData, fromPrimary)) {
                  void c.pasteClipboardImage();
                }
              }}
              onKeyDown={(e) => {
                const count = fileTrigger ? atItemCount : filteredItems.length;
                const action = composerKeyAction(
                  {
                    key: e.key,
                    shiftKey: e.shiftKey,
                    isComposing: e.nativeEvent.isComposing,
                    keyCode: e.keyCode,
                  },
                  { open: pickerOpen && !mcpForm, items: count },
                );
                if (!action) return;
                e.preventDefault();
                if (action === "picker-next") {
                  setActiveIndex((i) =>
                    Math.min(i + 1, Math.max(0, count - 1)),
                  );
                } else if (action === "picker-prev") {
                  setActiveIndex((i) => Math.max(0, i - 1));
                } else if (action === "picker-pick") {
                  pickActive();
                } else if (action === "picker-dismiss") {
                  if (fileTrigger) {
                    const before = c.value.slice(0, fileTrigger.start);
                    const after = c.value.slice(fileTrigger.end);
                    c.setValue(`${before}${after}`);
                    setFileTrigger(null);
                  } else {
                    setTrigger(null);
                  }
                } else if (!mcpForm) {
                  // An open MCP form sends (or attaches) from its own button.
                  c.submit();
                }
              }}
              placeholder="Ask Oarlock anything   -   # for snippets, / for commands and skills, @ for files"
              aria-busy={mcpForm !== null}
              rows={1}
              className={cn(
                "max-h-40 flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none",
                "placeholder:text-muted-foreground/60",
              )}
            />
            <AllFoldersChip />
            <ApprovalModeControl />
            <AgentSwitcher />
          </div>
        </PopoverAnchor>
        {mcpForm ? (
          <Suspense fallback={null}>
            <McpArgumentsForm key={mcpForm.id} form={mcpForm} />
          </Suspense>
        ) : fileTrigger ? (
          <FilePickerContent
            files={filteredFiles}
            mcpSections={mcpSections}
            mcpStarting={mcpStarting}
            activeIndex={activeIndex}
            indexing={workspaceFiles.indexing}
            truncated={workspaceFiles.truncated}
            hasWorkspace={workspaceRoot !== null}
            onPick={(f) => void onPickFile(f)}
            onPickMcp={(item) => void onPickMcp(item)}
            onHover={setActiveIndex}
          />
        ) : (
          <SnippetPickerContent
            items={filteredItems}
            mcpStarting={trigger?.char === "/" && mcpStarting}
            activeIndex={activeIndex}
            onPick={onPickItem}
            onHover={setActiveIndex}
          />
        )}
      </Popover>

      {voiceRow.mounted && (
        <div data-state={voiceRow.state} className="oarlock-reveal">
          <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            {c.voice.recording ? (
              <span className="size-1.5 oarlock-blink rounded-full bg-destructive" />
            ) : (
              <Spinner className="size-3" />
            )}
            <span className="truncate">
              {voiceLabel || lastVoiceLabel.current}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

function autoresize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}
