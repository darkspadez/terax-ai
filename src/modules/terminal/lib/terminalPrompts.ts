import { create } from "zustand";

/** Something a terminal asks the user before doing it. */
export type TerminalPromptRequest =
  /** A paste that would run commands (line breaks without bracketed paste). */
  | { readonly kind: "paste"; readonly text: string }
  /**
   * A program asked to read the clipboard (OSC 52, Kitty OSC 5522); Kitty
   * reads carry the name the program gives itself.
   */
  | { readonly kind: "clipboard-read"; readonly program?: string };

export type TerminalPromptAnswer = "allow" | "deny";

type PendingPrompt = {
  readonly id: number;
  readonly request: TerminalPromptRequest;
  readonly resolve: (answer: TerminalPromptAnswer) => void;
};

type TerminalPromptStore = {
  /** Oldest first; the dialog shows the head. */
  readonly queue: readonly PendingPrompt[];
  answer: (id: number, answer: TerminalPromptAnswer) => void;
};

/** At most this many prompts wait; later requests are denied, not stacked. */
const MAX_PENDING = 8;
let nextId = 1;

export const useTerminalPromptStore = create<TerminalPromptStore>((set) => ({
  queue: [],
  answer: (id, answer) =>
    set((state) => {
      const prompt = state.queue.find((entry) => entry.id === id);
      if (!prompt) return state;
      prompt.resolve(answer);
      return { queue: state.queue.filter((entry) => entry.id !== id) };
    }),
}));

/**
 * Asks the user; resolves when they answer. Repeated clipboard reads while one
 * is pending share its answer, so a program polling OSC 52 cannot stack
 * dialogs.
 */
export function requestTerminalPrompt(
  request: TerminalPromptRequest,
): Promise<TerminalPromptAnswer> {
  const { queue } = useTerminalPromptStore.getState();
  if (request.kind === "clipboard-read") {
    const waiting = queue.find(
      (entry) => entry.request.kind === "clipboard-read",
    );
    if (waiting) {
      return new Promise((resolve) => {
        const original = waiting.resolve;
        useTerminalPromptStore.setState((state) => ({
          queue: state.queue.map((entry) =>
            entry === waiting
              ? {
                  ...entry,
                  resolve: (answer: TerminalPromptAnswer) => {
                    original(answer);
                    resolve(answer);
                  },
                }
              : entry,
          ),
        }));
      });
    }
  }
  if (queue.length >= MAX_PENDING) return Promise.resolve("deny");
  return new Promise((resolve) => {
    const prompt: PendingPrompt = { id: nextId++, request, resolve };
    useTerminalPromptStore.setState((state) => ({
      queue: [...state.queue, prompt],
    }));
  });
}
