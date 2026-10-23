import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { liveModelConfig } from "@/modules/ai/store/modelConfig";
import {
  Cancel01Icon,
  McpServerIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { PendingSampling } from "../lib/requests";
import {
  chooseSamplingModel,
  initialDraft,
  SAMPLING_MAX_TOKENS,
  type SamplingDraft,
  samplingDraftProblem,
  stopReasonFor,
} from "../lib/sampling";
import { samplingModelChoice, usableSamplingModels } from "../sampling/models";

type Stage =
  | { kind: "review" }
  | { kind: "running"; model: string }
  | { kind: "result"; text: string; finishReason: string; model: string }
  | { kind: "failed"; error: string };

const CONTEXT_NOTE: Record<"thisServer" | "allServers", string> = {
  thisServer: "context from this server",
  allServers: "context from all MCP servers",
};

function rowsFor(text: string, max = 10): number {
  return Math.min(max, Math.max(2, text.split("\n").length));
}

/**
 * A server's sampling request, for the user to review, edit, approve or deny,
 * then (after it ran) to review the reply before it goes back. It never runs
 * on its own: the server's trust and the conversation's approval mode play
 * no part. Closing it denies.
 */
export function SamplingDialog({ request }: { request: PendingSampling }) {
  const { view, serverName } = request;
  const [draft, setDraft] = useState<SamplingDraft>(() => initialDraft(view));
  const [maxTokensText, setMaxTokensText] = useState(() =>
    String(initialDraft(view).maxTokens),
  );
  const [models] = useState(() =>
    usableSamplingModels(useChatStore.getState().apiKeys, liveModelConfig()),
  );
  const [current] = useState(() =>
    samplingModelChoice(
      useChatStore.getState().selectedModelId,
      liveModelConfig(),
    ),
  );
  const [choice] = useState(() =>
    chooseSamplingModel(view.hints, current, models),
  );
  const [modelId, setModelId] = useState(choice.model.id);
  const [stage, setStage] = useState<Stage>({ kind: "review" });
  /** The generation running, if any; stopped when the request ends. */
  const running = useRef<AbortController | null>(null);

  // The server cancelled its request or stopped: the dialog goes with it.
  useEffect(() => {
    const onAbort = () => {
      running.current?.abort();
      toast.message(`${serverName} withdrew its request to use the model`);
    };
    request.signal.addEventListener("abort", onAbort);
    return () => request.signal.removeEventListener("abort", onAbort);
  }, [request.signal, serverName]);

  const usable = models.some((m) => m.id === modelId);
  const problem = samplingDraftProblem(draft);

  const deny = () => {
    running.current?.abort();
    request.answer({ kind: "denied" });
  };

  const run = async () => {
    if (problem || !usable) return;
    const controller = new AbortController();
    running.current = controller;
    const model = models.find((m) => m.id === modelId)?.label ?? modelId;
    setStage({ kind: "running", model });
    try {
      const { runSampling } = await import("../sampling/run");
      const out = await runSampling({
        modelId,
        draft,
        temperature: view.temperature,
        stopSequences: view.stopSequences,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setStage({
        kind: "result",
        text: out.text,
        finishReason: out.finishReason,
        model: out.model,
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      setStage({
        kind: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (running.current === controller) running.current = null;
    }
  };

  const send = () => {
    if (stage.kind !== "result") return;
    request.answer({
      kind: "result",
      text: stage.text,
      model: stage.model,
      finishReason: stage.finishReason,
    });
  };

  const editing = stage.kind === "review";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) deny();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <DialogHeader className="gap-1 border-b border-border/60 px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-[13px]">
            <span className="size-1.5 shrink-0 rounded-full bg-amber-500 terax-attention-pulse" />
            <HugeiconsIcon
              icon={McpServerIcon}
              size={14}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 truncate">
              {serverName} asks to use your AI model
            </span>
            <span className="ml-auto shrink-0 text-[10px] font-normal text-muted-foreground">
              {stage.kind === "result"
                ? "reply needs approval"
                : "needs approval"}
            </span>
          </DialogTitle>
          <DialogDescription className="text-[11.5px] leading-relaxed">
            The MCP server {serverName} wants a reply from your model, paid by
            your key. Nothing runs until you approve, no conversation is
            included, and you see the reply before it goes back to the server.
            Everything below was written by the server.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[12px]">
          {view.includeContext !== "none" ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-300">
              It asked to include {CONTEXT_NOTE[view.includeContext]}. Terax
              includes none: only the messages below are sent.
            </div>
          ) : null}

          {stage.kind === "result" ? (
            <ResultView
              stage={stage}
              onChange={(text) => setStage({ ...stage, text })}
            />
          ) : (
            <>
              <section className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1">
                  <label
                    htmlFor={`${request.id}-model`}
                    className="block text-[10.5px] font-medium text-muted-foreground"
                  >
                    Model
                  </label>
                  {models.length > 0 ? (
                    <select
                      id={`${request.id}-model`}
                      value={usable ? modelId : ""}
                      disabled={!editing}
                      onChange={(e) => setModelId(e.target.value)}
                      className="h-7 w-full rounded-md border border-border bg-background px-1.5 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {usable ? null : (
                        <option value="" disabled>
                          Choose a model
                        </option>
                      )}
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                          {m.id === current.id ? " (this conversation's)" : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="text-[11px] text-destructive">
                      No model can run: add a provider in Settings, Models.
                    </div>
                  )}
                  <span className="block text-[10.5px] text-muted-foreground">
                    {choice.hint && modelId === choice.model.id
                      ? `Matches the server's preference "${choice.hint}".`
                      : modelId === current.id
                        ? "The conversation's model."
                        : "Chosen by you."}
                    {view.hints.length > 0
                      ? ` The server prefers: ${view.hints.join(", ")}.`
                      : ""}
                  </span>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor={`${request.id}-max-tokens`}
                    className="block text-[10.5px] font-medium text-muted-foreground"
                  >
                    Max tokens
                  </label>
                  <input
                    id={`${request.id}-max-tokens`}
                    value={maxTokensText}
                    disabled={!editing}
                    inputMode="numeric"
                    onChange={(e) => {
                      setMaxTokensText(e.target.value);
                      const n = Number(e.target.value.trim());
                      setDraft((d) => ({
                        ...d,
                        maxTokens: e.target.value.trim() ? n : Number.NaN,
                      }));
                    }}
                    className="h-7 w-28 rounded-md border border-border bg-background px-2 text-[12px] tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <span className="block text-[10.5px] text-muted-foreground">
                    Asked {view.maxTokens.toLocaleString("en-US")}; at most{" "}
                    {SAMPLING_MAX_TOKENS.toLocaleString("en-US")}.
                  </span>
                </div>
              </section>

              <RequestDetails request={request} />

              <section className="space-y-1">
                <div className="text-[10.5px] font-medium text-muted-foreground">
                  System prompt, from {serverName}
                </div>
                <textarea
                  value={draft.systemPrompt}
                  disabled={!editing}
                  placeholder="(none)"
                  rows={rowsFor(draft.systemPrompt, 6)}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, systemPrompt: e.target.value }))
                  }
                  className="w-full resize-y rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </section>

              <section className="space-y-2">
                <div className="text-[10.5px] font-medium text-muted-foreground">
                  Messages, from {serverName}
                </div>
                {draft.messages.map((message, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: messages never reorder.
                    key={index}
                    className="space-y-1 rounded-md border border-border/60 p-2"
                  >
                    <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {message.role === "assistant" ? "Assistant" : "User"}
                    </div>
                    <textarea
                      value={message.text}
                      disabled={!editing}
                      rows={rowsFor(message.text)}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          messages: d.messages.map((m, i) =>
                            i === index ? { ...m, text: e.target.value } : m,
                          ),
                        }))
                      }
                      className="w-full resize-y rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    {message.images.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {message.images.map((image, imageIndex) => (
                          <div
                            // biome-ignore lint/suspicious/noArrayIndexKey: images never reorder.
                            key={imageIndex}
                            className="group relative"
                          >
                            <img
                              alt="Sent by the server"
                              src={`data:${image.mediaType};base64,${image.data}`}
                              className="h-16 max-w-32 rounded border border-border/60 object-cover"
                            />
                            {editing ? (
                              <button
                                type="button"
                                aria-label="Leave this image out"
                                title="Leave this image out"
                                onClick={() =>
                                  setDraft((d) => ({
                                    ...d,
                                    messages: d.messages.map((m, i) =>
                                      i === index
                                        ? {
                                            ...m,
                                            images: m.images.filter(
                                              (_, j) => j !== imageIndex,
                                            ),
                                          }
                                        : m,
                                    ),
                                  }))
                                }
                                className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-sm bg-background/90 opacity-0 transition-opacity group-hover:opacity-100"
                              >
                                <HugeiconsIcon
                                  icon={Cancel01Icon}
                                  size={10}
                                  strokeWidth={2}
                                />
                              </button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </section>
            </>
          )}

          {stage.kind === "failed" ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] whitespace-pre-wrap text-destructive">
              {stage.error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5 border-t border-border/60 px-4 py-2.5">
          <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {stage.kind === "running" ? (
              <span className="flex items-center gap-1.5">
                <Spinner className="size-3" />
                Generating with {stage.model}…
              </span>
            ) : stage.kind === "result" ? (
              `From ${stage.model}, ${describeStop(stage.finishReason)}. It goes to ${serverName} only if you send it.`
            ) : editing && problem ? (
              <span className="text-destructive">{problem}</span>
            ) : null}
          </div>
          {stage.kind === "failed" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setStage({ kind: "review" })}
              className="h-7 text-[11px]"
            >
              Edit request
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={deny}
            className="h-7 gap-1.5 text-[11px]"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            {stage.kind === "result" ? "Don't send" : "Deny"}
          </Button>
          {stage.kind === "result" ? (
            <Button
              size="sm"
              onClick={send}
              className="h-7 gap-1.5 text-[11px]"
            >
              <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
              Send to {serverName}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!editing || problem !== null || !usable}
              onClick={() => void run()}
              className={cn("h-7 gap-1.5 text-[11px]")}
            >
              <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
              Approve and run
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function describeStop(finishReason: string): string {
  const reason = stopReasonFor(finishReason);
  if (reason === "endTurn") return "finished";
  if (reason === "maxTokens") return "cut at the token limit";
  return `stopped (${reason})`;
}

function RequestDetails({ request }: { request: PendingSampling }) {
  const { view } = request;
  const priorities = (
    [
      ["cost", view.priorities.cost],
      ["speed", view.priorities.speed],
      ["intelligence", view.priorities.intelligence],
    ] as const
  ).filter(([, value]) => value !== null);
  const details = [
    view.temperature !== null ? `temperature ${view.temperature}` : null,
    view.stopSequences.length > 0
      ? `stops at ${view.stopSequences.map((s) => JSON.stringify(s)).join(", ")}`
      : null,
    priorities.length > 0
      ? `priorities: ${priorities.map(([name, value]) => `${name} ${value}`).join(", ")}`
      : null,
  ].filter((d): d is string => d !== null);
  if (details.length === 0) return null;
  return (
    <div className="text-[10.5px] text-muted-foreground">
      The server also asks for {details.join("; ")}.
    </div>
  );
}

function ResultView({
  stage,
  onChange,
}: {
  stage: Extract<Stage, { kind: "result" }>;
  onChange: (text: string) => void;
}) {
  return (
    <section className="space-y-1">
      <div className="text-[10.5px] font-medium text-muted-foreground">
        Reply to send back (you can edit it)
      </div>
      <textarea
        value={stage.text}
        rows={rowsFor(stage.text, 16)}
        onChange={(e) => onChange(e.target.value)}
        className="w-full resize-y rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </section>
  );
}
