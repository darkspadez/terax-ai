/**
 * Marks the AI composer while the input bar shows it (a block terminal's
 * shell input is not marked): AI-only shortcuts and explorer drops act there.
 */
export const AI_COMPOSER_ATTR = "data-ai-composer";

const AI_COMPOSER = `[${AI_COMPOSER_ATTR}]`;
const AI_CHAT_WINDOW = "[data-ai-mini-window]";

type MaybeElement = { closest?: (selector: string) => unknown } | null;

/** `target` (an element, or what a drag is over) is in the AI composer. */
export function isAiComposerTarget(target: EventTarget | null): boolean {
  return !!(target as MaybeElement)?.closest?.(AI_COMPOSER);
}

/** `target` (the focused element) is in the AI composer or the chat window. */
export function isAiSurfaceTarget(target: EventTarget | null): boolean {
  return !!(target as MaybeElement)?.closest?.(
    `${AI_COMPOSER}, ${AI_CHAT_WINDOW}`,
  );
}
