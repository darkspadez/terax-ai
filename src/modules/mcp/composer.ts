import type { FileAttachment } from "@/modules/ai/lib/composer";
import { toast } from "sonner";
import {
  encodeForSending,
  imageNeedsEncoding,
} from "@/modules/ai/lib/imageAttachment";
import {
  type CompletionRef,
  completeMcpArgument,
  ensureMcpExtras,
  getMcpPrompt,
  readMcpResource,
  readMcpTemplate,
} from "./extras";
import {
  type ArgumentField,
  type ArgumentsFormRequest,
  filledArguments,
} from "./lib/argumentsForm";
import { mcpResourceBlock } from "./lib/blocks";
import { labelText } from "./lib/displayText";
import { type McpTemplateEntry, useMcpExtras } from "./lib/extrasCatalog";
import { type McpPromptCommand, promptCommands } from "./lib/promptCommands";
import { type PromptImage, promptMessage } from "./lib/promptMessages";
import {
  type ResourceDraft,
  resourceAttachments,
} from "./lib/resourceAttachments";

/**
 * The composer's MCP actions, loaded when first used: running a prompt
 * (`/server:prompt`, with its form when it takes arguments) and attaching a
 * resource or a filled-in template from the `@` picker.
 */

let formCount = 0;

function completer(
  serverId: string,
  ref: CompletionRef,
): ArgumentsFormRequest["complete"] {
  const server = useMcpExtras
    .getState()
    .servers.find((s) => s.serverId === serverId);
  if (!server?.completions) return undefined;
  return (field, value, values) =>
    completeMcpArgument(serverId, ref, { name: field, value }, values);
}

export type PromptCallOutcome =
  | { kind: "message"; block: string; images: PromptImage[]; notes: string[] }
  /** No prompt by that name runs here: a typed one is sent as written. */
  | { kind: "missing" }
  | { kind: "cancelled" };

async function findPrompt(command: string): Promise<McpPromptCommand | null> {
  const find = () =>
    promptCommands(useMcpExtras.getState().servers).find(
      (c) => c.command === command,
    ) ?? null;
  const found = find();
  if (found) return found;
  await ensureMcpExtras();
  return find();
}

async function fetchPrompt(
  command: McpPromptCommand,
  args: Record<string, string>,
): Promise<{ block: string; images: PromptImage[]; notes: string[] }> {
  const result = await getMcpPrompt(
    command.serverId,
    command.prompt.name,
    args,
  );
  const message = promptMessage(
    result,
    command.serverName,
    command.prompt.name,
  );
  if ("error" in message) throw new Error(message.error);
  return message;
}

/**
 * `/server:prompt`: gets the prompt's messages, after asking for its
 * arguments in the composer's form when it takes any (`showForm`; the call
 * settles when the user sends or cancels it).
 */
export async function startPromptCall(
  command: string,
  showForm: (form: ArgumentsFormRequest) => void,
): Promise<PromptCallOutcome> {
  const found = await findPrompt(command);
  if (!found) return { kind: "missing" };
  if (found.prompt.arguments.length === 0) {
    return { kind: "message", ...(await fetchPrompt(found, {})) };
  }
  const fields: ArgumentField[] = found.prompt.arguments.map((a) => ({
    name: a.name,
    label: a.title ?? a.name,
    description: a.description,
    required: a.required,
  }));
  return new Promise<PromptCallOutcome>((resolve) => {
    showForm({
      id: `mcp-form-${++formCount}`,
      title: `/${found.command}`,
      serverName: found.serverName,
      description: found.prompt.description ?? found.prompt.title,
      fields,
      submitLabel: "Send",
      complete: completer(found.serverId, {
        type: "ref/prompt",
        name: found.prompt.name,
      }),
      submit: async (values) => {
        const message = await fetchPrompt(
          found,
          filledArguments(fields, values),
        );
        resolve({ kind: "message", ...message });
      },
      cancel: () => resolve({ kind: "cancelled" }),
    });
  });
}

/**
 * A prompt call from the composer, start to end: the form when it takes
 * arguments, then the message (`send`), or the typed text as written when no
 * running server offers that prompt; failures and left-out parts in toasts.
 */
export async function runPromptCall(call: {
  command: string;
  /** Picked from the list (a chip), not typed. */
  picked: boolean;
  showForm: (form: ArgumentsFormRequest) => void;
  send: (block: string, images: PromptImage[]) => void;
  sendAsWritten: () => void;
}): Promise<void> {
  try {
    const outcome = await startPromptCall(call.command, call.showForm);
    if (outcome.kind === "message") {
      if (outcome.notes.length > 0) {
        toast.message("Part of the prompt was left out", {
          description: outcome.notes.join(" "),
        });
      }
      call.send(outcome.block, outcome.images);
    } else if (outcome.kind === "missing") {
      if (call.picked) {
        toast.error(`The prompt /${call.command} is not available`);
      } else {
        call.sendAsWritten();
      }
    }
  } catch (e) {
    toast.error(`Could not run /${call.command}`, {
      description: e instanceof Error ? e.message : String(e),
    });
  }
}

function base64Blob(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function dataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function attachmentOf(
  serverId: string,
  serverName: string,
  draft: ResourceDraft,
): Promise<FileAttachment | string> {
  const base = {
    id: `mcp:${serverId}:${draft.uri}:${draft.name}`,
    name: draft.name,
    mcp: { server: serverName, uri: draft.uri },
  };
  if (draft.kind === "text") {
    return {
      ...base,
      kind: "text",
      mediaType: draft.mediaType,
      text: draft.text,
      size: draft.size,
      block: mcpResourceBlock(serverName, { ...draft, text: draft.text }),
    };
  }
  let mediaType = draft.mediaType;
  let size = draft.size;
  let url = `data:${draft.mediaType};base64,${draft.data}`;
  if (imageNeedsEncoding(draft.mediaType, draft.size)) {
    const encoded = await encodeForSending(
      base64Blob(draft.data, draft.mediaType),
    );
    if (!encoded) {
      return `${draft.name}: the image could not be converted or made small enough.`;
    }
    mediaType = encoded.type;
    size = encoded.size;
    url = await dataUrl(encoded);
  }
  return {
    ...base,
    kind: "image",
    mediaType,
    url,
    size,
    block: mcpResourceBlock(serverName, { ...draft, mediaType, text: null }),
  };
}

export type ResourceFiles = { files: FileAttachment[]; refused: string[] };

async function filesOf(
  serverId: string,
  serverName: string,
  result: unknown,
  request: { uri: string; name: string },
): Promise<ResourceFiles> {
  const { drafts, refused } = resourceAttachments(result, request);
  const files: FileAttachment[] = [];
  for (const draft of drafts) {
    const file = await attachmentOf(serverId, serverName, draft);
    if (typeof file === "string") refused.push(file);
    else files.push(file);
  }
  return { files, refused };
}

/** A resource from the `@` picker, read and made attachments. */
export async function resourceFiles(
  serverId: string,
  serverName: string,
  resource: { uri: string; name: string },
): Promise<ResourceFiles> {
  const result = await readMcpResource(serverId, resource.uri);
  return filesOf(serverId, serverName, result, resource);
}

/**
 * The form a resource template opens: its variables, the server's
 * suggestions, and on Attach the resource it names, read and attached.
 */
export function templateForm(
  item: { serverId: string; serverName: string; template: McpTemplateEntry },
  attach: (files: ResourceFiles) => void,
  cancel: () => void,
): ArgumentsFormRequest {
  const { serverId, serverName, template } = item;
  const fields: ArgumentField[] = template.variables.map((name) => ({
    name,
    label: name,
    required: !template.optional.includes(name),
  }));
  return {
    id: `mcp-form-${++formCount}`,
    title: template.title ?? template.name,
    serverName,
    description: template.description ?? template.uriTemplate,
    fields,
    submitLabel: "Attach",
    complete: completer(serverId, {
      type: "ref/resource",
      uri: template.uriTemplate,
    }),
    submit: async (values) => {
      const { uri, result } = await readMcpTemplate(
        serverId,
        template.uriTemplate,
        filledArguments(fields, values),
      );
      const tail = uri
        .replace(/[?#].*$/, "")
        .split("/")
        .filter(Boolean)
        .pop();
      const files = await filesOf(serverId, serverName, result, {
        uri,
        name: labelText(tail ?? "", 120) || template.name,
      });
      if (files.files.length === 0) {
        throw new Error(files.refused.join(" ") || "Nothing to attach.");
      }
      attach(files);
    },
    cancel,
  };
}
