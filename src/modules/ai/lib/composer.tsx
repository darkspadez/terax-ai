import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useWhisperRecording } from "../hooks/useWhisperRecording";
import { expandSnippetTokens, type Snippet } from "../lib/snippets";
import {
  COMPOSER_DROP_EVENT,
  type DroppedPath,
  folderReference,
  insertIntoPrompt,
  planComposerDrop,
} from "./composerDrop";
import type { ReadResult } from "./native";
import { encodeForSending, imageNeedsEncoding } from "./imageAttachment";
import { fileBlock, selectionBlock, snippetBlock } from "./messageBlocks";
import { readClipboardImageFile } from "./pastedImages";
import {
  attachableText,
  attachmentName,
  MAX_TEXT_ATTACHMENT_BYTES,
  readDroppedFile,
  readPickedFile,
  textTooLarge,
} from "./pathAttachment";
import type { ArgumentsFormRequest } from "@/modules/mcp/lib/argumentsForm";
import { parseMcpPromptInvocation } from "@/modules/mcp/slash";
import { parseSkillInvocation } from "@/modules/skills/slash";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  SLASH_COMMANDS,
  tryRunSlashCommand,
  type SlashCommandMeta,
} from "./slashCommands";
import { getChat, useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";

export type FileAttachment = {
  id: string;
  name: string;
  kind: "image" | "text" | "selection";
  mediaType: string;
  url?: string;
  text?: string;
  size: number;
  /** For kind === "selection": which surface it came from. */
  source?: "terminal" | "editor";
  /** Read from an MCP server's resource: shown as that server's. */
  mcp?: { server: string; uri: string };
  /** The block it sends instead of a `<file>` one (an MCP resource's). */
  block?: string;
};

type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string };

export const ACCEPTED_FILES =
  "image/*,.txt,.md,.json,.yaml,.yml,.toml,.sh,.zsh,.bash,.py,.js,.jsx,.ts,.tsx,.rs,.go,.java,.c,.cpp,.h,.hpp,.html,.css,.csv,.log,.env,.config,.conf,.ini,Dockerfile,.dockerfile";

type Voice = ReturnType<typeof useWhisperRecording>;

type ComposerCtx = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  files: FileAttachment[];
  addFiles: (list: FileList | readonly File[] | null) => Promise<void>;
  /** Attach the clipboard's image as the app reads it (a paste the webview
   *  handed no image, `pasteNeedsClipboardImage`). */
  pasteClipboardImage: () => Promise<void>;
  /** Attach a file by absolute path — used by the file explorer's "Attach to Agent". */
  attachFileByPath: (path: string) => Promise<void>;
  /** Attach prepared attachments (MCP resources); one already attached is kept once. */
  attachFiles: (files: readonly FileAttachment[]) => void;
  /** The open form of an MCP prompt or resource template, if any. */
  mcpForm: ArgumentsFormRequest | null;
  setMcpForm: (form: ArgumentsFormRequest | null) => void;
  removeFile: (id: string) => void;
  pickedSnippets: Snippet[];
  addSnippet: (s: Snippet) => void;
  removeSnippet: (id: string) => void;
  pickedCommands: SlashCommandMeta[];
  addCommand: (c: SlashCommandMeta) => void;
  removeCommand: (name: string) => void;
  isBusy: boolean;
  submit: () => void;
  stop: () => void;
  voice: Voice;
  canSend: boolean;
};

const Ctx = createContext<ComposerCtx | null>(null);

export function useComposer(): ComposerCtx {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useComposer must be used inside <AiComposerProvider>");
  return ctx;
}

type ProviderProps = {
  children: React.ReactNode;
};

export function AiComposerProvider({ children }: ProviderProps) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const status = useChatStore((s) => s.agentMeta.status);
  const isBusy = status === "thinking" || status === "streaming";

  const [value, setValue] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [pickedSnippets, setPickedSnippets] = useState<Snippet[]>([]);
  const [pickedCommands, setPickedCommands] = useState<SlashCommandMeta[]>([]);
  const [mcpForm, setMcpForm] = useState<ArgumentsFormRequest | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const focusSignal = useChatStore((s) => s.focusSignal);
  const pendingPrefill = useChatStore((s) => s.pendingPrefill);
  const consumePrefill = useChatStore((s) => s.consumePrefill);
  const pendingSelections = useChatStore((s) => s.pendingSelections);
  const consumeSelections = useChatStore((s) => s.consumeSelections);

  useEffect(() => {
    if (focusSignal === 0) return;
    textareaRef.current?.focus();
    if (pendingPrefill != null) {
      const text = consumePrefill();
      if (text) setValue((v) => (v ? `${text}${v}` : text));
    }
  }, [focusSignal, pendingPrefill, consumePrefill]);

  // Re-focus the textarea whenever the agent finishes a response
  const prevIsBusyRef = useRef(false);
  useEffect(() => {
    if (prevIsBusyRef.current && !isBusy) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    prevIsBusyRef.current = isBusy;
  }, [isBusy, textareaRef]);

  // Listen for explorer's "Attach to Agent" event.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (typeof path === "string" && path.length > 0) {
        void attachFileByPath(path);
      }
    };
    window.addEventListener("terax:ai-attach-file", onAttach);
    return () => window.removeEventListener("terax:ai-attach-file", onAttach);
    // attachFileByPath is stable for our purposes (closes over setFiles only)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pendingSelections.length === 0) return;
    const drained = consumeSelections();
    if (drained.length === 0) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.id));
      const next: FileAttachment[] = [];
      for (const sel of drained) {
        if (existing.has(sel.id)) continue;
        next.push({
          id: sel.id,
          name:
            sel.source === "editor"
              ? "Editor selection"
              : "Terminal selection",
          kind: "selection",
          mediaType: "text/plain",
          text: sel.text,
          size: sel.text.length,
          source: sel.source,
        });
      }
      return next.length ? [...prev, ...next] : prev;
    });
  }, [pendingSelections, consumeSelections]);

  const voice = useWhisperRecording({
    onResult: (transcript: string) => {
      setValue((v) => (v ? `${v} ${transcript}` : transcript));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  });

  const addFiles = async (list: FileList | readonly File[] | null) => {
    if (!list) return;
    const next: FileAttachment[] = [];
    for (const f of Array.from(list)) {
      const att = await readAttachment(f);
      if (att) next.push(att);
    }
    if (next.length) setFiles((prev) => [...prev, ...next]);
  };

  const pasteClipboardImage = async () => {
    const image = await readClipboardImageFile();
    if (image) await addFiles([image]);
  };

  const removeFile = (id: string) =>
    setFiles((prev) => prev.filter((f) => f.id !== id));

  const attachFiles = (added: readonly FileAttachment[]) =>
    setFiles((prev) => {
      const ids = new Set(prev.map((f) => f.id));
      const next = added.filter((f) => !ids.has(f.id));
      return next.length > 0 ? [...prev, ...next] : prev;
    });

  const addSnippet = (s: Snippet) =>
    setPickedSnippets((prev) =>
      prev.some((p) => p.id === s.id) ? prev : [...prev, s],
    );
  const removeSnippet = (id: string) =>
    setPickedSnippets((prev) => prev.filter((s) => s.id !== id));

  const addCommand = (cmd: SlashCommandMeta) =>
    setPickedCommands((prev) =>
      prev.some((p) => p.name === cmd.name) ? prev : [...prev, cmd],
    );
  const removeCommand = (name: string) =>
    setPickedCommands((prev) => prev.filter((c) => c.name !== name));

  // Picked by the user (Attach to Agent, an @ mention) or dropped from the
  // explorer, which reads only what the agent itself may read.
  const attachFileByPath = async (
    path: string,
    via: "picked" | "dropped" = "picked",
  ) => {
    const name = attachmentName(path);
    let result: ReadResult;
    try {
      result =
        via === "dropped"
          ? await readDroppedFile(path)
          : await readPickedFile(path);
    } catch (e) {
      toast.error(`Could not attach ${name}`, {
        description: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const attachable = attachableText(result);
    if (!attachable.ok) {
      toast.error(`Could not attach ${name}`, {
        description: attachable.reason,
      });
      return;
    }
    const id = `path-${path}`;
    setFiles((prev) => {
      if (prev.some((f) => f.id === id)) return prev;
      const att: FileAttachment = {
        id,
        name,
        kind: "text",
        mediaType: "text/plain",
        text: attachable.text,
        size: attachable.size,
      };
      return [...prev, att];
    });
    // Open the AI panel & focus the input so the user sees the chip.
    useChatStore.getState().focusInput();
  };

  // Explorer items dropped on the composer: folders are named at the caret
  // (or at the end), files attach one by one.
  const onDropPaths = useEffectEvent(async (entries: DroppedPath[]) => {
    const { files, folders } = planComposerDrop(entries);
    if (folders.length > 0) {
      const el = textareaRef.current;
      const selection =
        el && document.activeElement === el
          ? { start: el.selectionStart, end: el.selectionEnd }
          : null;
      const next = insertIntoPrompt(
        value,
        selection,
        folders.map(folderReference).join(" "),
      );
      setValue(next.value);
      useChatStore.getState().focusInput();
      requestAnimationFrame(() =>
        textareaRef.current?.setSelectionRange(next.caret, next.caret),
      );
    }
    for (const path of files) await attachFileByPath(path, "dropped");
  });
  useEffect(() => {
    const onDrop = (e: Event) => {
      const entries = (e as CustomEvent<DroppedPath[]>).detail;
      if (Array.isArray(entries)) void onDropPaths(entries);
    };
    window.addEventListener(COMPOSER_DROP_EVENT, onDrop);
    return () => window.removeEventListener(COMPOSER_DROP_EVENT, onDrop);
  }, []);

  // A skill or an MCP prompt is loaded (an MCP prompt's arguments asked for)
  // before its message is sent; nothing else is sent meanwhile.
  const preparing = useRef(false);

  const submit = () => {
    if (isBusy || preparing.current) return;
    const trimmed = value.trim();
    if (
      !trimmed &&
      files.length === 0 &&
      pickedSnippets.length === 0 &&
      pickedCommands.length === 0
    )
      return;

    // `/server:prompt ...` (typed, or picked as a chip) sends the MCP
    // prompt's messages with the user's text, after its form if it takes
    // arguments. A typed one no running server offers is sent as written.
    const pickedPrompt = pickedCommands.find((c) => c.prompt);
    const typedPrompt = pickedPrompt ? null : parseMcpPromptInvocation(trimmed);
    const promptCall = pickedPrompt
      ? { command: pickedPrompt.name, text: trimmed }
      : typedPrompt;
    if (promptCall) {
      preparing.current = true;
      void import("@/modules/mcp/composer")
        .then(({ runPromptCall }) =>
          runPromptCall({
            command: promptCall.command,
            picked: pickedPrompt !== undefined,
            showForm: setMcpForm,
            send: (block, images) =>
              send(promptCall.text, null, [block], images),
            sendAsWritten: () => send(trimmed, null, []),
          }),
        )
        .finally(() => {
          setMcpForm(null);
          preparing.current = false;
        });
      return;
    }

    // `/skill-name ...` (typed, or picked as a chip) sends the skill's
    // instructions with the user's text. Built-in commands keep their names.
    const pickedSkill = pickedCommands.find((c) => c.skill);
    const typedSkill = pickedSkill ? null : parseSkillInvocation(trimmed);
    const skillCall = pickedSkill
      ? { name: pickedSkill.name, args: trimmed }
      : typedSkill && !SLASH_COMMANDS[typedSkill.name]
        ? typedSkill
        : null;
    if (skillCall) {
      preparing.current = true;
      void (async () => {
        try {
          const { skillInvocation } = await import("@/modules/skills/composer");
          const result = await skillInvocation(
            skillCall.name,
            skillCall.args,
            useChatStore.getState().live.getWorkspaceRoot(),
            currentWorkspaceEnv(),
          );
          if (result.kind === "block") {
            send(skillCall.args, null, [result.block]);
          } else if (pickedSkill) {
            toast.error(`The skill ${skillCall.name} is not available`);
          } else {
            send(trimmed, null, []);
          }
        } catch (e) {
          toast.error(`Could not load the skill ${skillCall.name}`, {
            description: e instanceof Error ? e.message : String(e),
          });
        } finally {
          preparing.current = false;
        }
      })();
      return;
    }

    // Slash-command interception. `/plan` toggles plan mode; `/init` rewrites
    // the prompt to the TERAX.md scan template before sending.
    let effectiveText = trimmed;
    let commandMarker: string | null = null;
    let commandSource = trimmed;
    if (pickedCommands.length > 0 && !trimmed.startsWith("/") && !trimmed.startsWith("#")) {
      commandSource = `#${pickedCommands[0].name} ${trimmed}`.trim();
    }
    if (commandSource.startsWith("/") || commandSource.startsWith("#")) {
      const outcome = tryRunSlashCommand(commandSource);
      if (outcome.kind === "handled") {
        setValue("");
        if (outcome.toast) console.info(outcome.toast);
        return;
      }
      if (outcome.kind === "send-prompt") {
        effectiveText = outcome.prompt;
        if (outcome.commandName) {
          commandMarker = `<terax-command name="${outcome.commandName}" />`;
        }
      }
    }
    send(effectiveText, commandMarker, []);
  };

  /** Sends the message: the command marker, `leading` blocks (a skill's or an
   *  MCP prompt's, whose images come as `leadingImages`), snippets, selections
   *  and files, then the text. */
  const send = (
    effectiveText: string,
    commandMarker: string | null,
    leading: string[],
    leadingImages: readonly { mediaType: string; data: string }[] = [],
  ) => {
    const parts: MessagePart[] = [];
    const fileBlocks = files.flatMap((f) =>
      f.block
        ? [f.block]
        : f.kind === "text"
          ? [fileBlock(f.name, f.mediaType, f.text ?? "")]
          : [],
    );
    const selectionBlocks = files
      .filter((f) => f.kind === "selection")
      .map((f) => selectionBlock(f.source ?? "terminal", f.text ?? ""));
    const { body: bodyAfterTokens, blocks: snippetBlocks } = expandSnippetTokens(
      effectiveText,
      useSnippetsStore.getState().snippets,
    );
    const seenHandles = new Set<string>();
    const allSnippetBlocks: string[] = [];
    for (const s of pickedSnippets) {
      if (seenHandles.has(s.handle)) continue;
      seenHandles.add(s.handle);
      allSnippetBlocks.push(snippetBlock(s.handle, s.content));
    }
    for (const block of snippetBlocks) {
      const m = block.match(/^<snippet name="([^"]+)"/);
      if (m && seenHandles.has(m[1])) continue;
      if (m) seenHandles.add(m[1]);
      allSnippetBlocks.push(block);
    }
    const composed = [
      commandMarker ?? "",
      ...leading,
      allSnippetBlocks.join("\n\n"),
      selectionBlocks.join("\n\n"),
      fileBlocks.join("\n\n"),
      bodyAfterTokens,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (composed) parts.push({ type: "text", text: composed });

    for (const image of leadingImages) {
      parts.push({
        type: "file",
        mediaType: image.mediaType,
        url: `data:${image.mediaType};base64,${image.data}`,
      });
    }

    for (const f of files) {
      if (f.kind === "image" && f.url) {
        parts.push({
          type: "file",
          mediaType: f.mediaType,
          url: f.url,
          filename: f.name,
        });
      }
    }

    if (!sessionId) return;
    const store = useChatStore.getState();
    store.patchAgentMeta({ hitStepCap: false, compactionNotice: null });
    if (!store.mini.open) store.openMini();
    void (async () => {
      const { getOrCreateChat, sendUserMessage } = await import(
        "../store/chatRuntime"
      );
      const chat = getOrCreateChat(sessionId);
      void sendUserMessage(chat, { role: "user", parts } as Parameters<
        typeof chat.sendMessage
      >[0]);
    })();
    setValue("");
    setFiles([]);
    setPickedSnippets([]);
    setPickedCommands([]);
    // Re-focus immediately after submit so the user can type a follow-up
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const stop = () => {
    if (!sessionId) return;
    void getChat(sessionId)?.stop();
  };

  const canSend =
    !isBusy &&
    (value.trim().length > 0 ||
      files.length > 0 ||
      pickedSnippets.length > 0 ||
      pickedCommands.length > 0);

  const ctx: ComposerCtx = {
    textareaRef,
    value,
    setValue,
    files,
    addFiles,
    pasteClipboardImage,
    attachFileByPath,
    attachFiles,
    mcpForm,
    setMcpForm,
    removeFile,
    pickedSnippets,
    addSnippet,
    removeSnippet,
    pickedCommands,
    addCommand,
    removeCommand,
    isBusy,
    submit,
    stop,
    voice,
    canSend,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

/** A picked or pasted file as an attachment; null (said in a toast) when it
 *  cannot be one. */
async function readAttachment(file: File): Promise<FileAttachment | null> {
  const id = `${file.name}-${file.size}-${file.lastModified}`;
  const name = file.name || "image";
  if (file.type.startsWith("image/")) {
    const image = imageNeedsEncoding(file.type, file.size)
      ? await encodeForSending(file)
      : file;
    if (!image) {
      toast.error(`Could not attach ${name}`, {
        description:
          "The AI takes PNG, JPEG, GIF and WebP images, and this one could not be converted or made small enough.",
      });
      return null;
    }
    const url = await readAsDataURL(image);
    return {
      id,
      name: image.name,
      kind: "image",
      mediaType: image.type,
      url,
      size: image.size,
    };
  }
  if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
    toast.error(`Could not attach ${name}`, {
      description: textTooLarge(file.size),
    });
    return null;
  }
  const text = await file.text();
  return {
    id,
    name: file.name,
    kind: "text",
    mediaType: file.type || "text/plain",
    text,
    size: file.size,
  };
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
