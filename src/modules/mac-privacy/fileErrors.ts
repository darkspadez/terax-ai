import { IS_MAC } from "@/lib/platform";
import { toast } from "sonner";
import type { PrivacyRefusal } from "./explain";
import { isOperationNotPermitted } from "./lib/operationNotPermitted";
import { openPrivacySettings } from "./native";

/**
 * The one place file errors from the editor, explorer, previews, searches and
 * Source Control pass through on their way to the user. On macOS a refusal by
 * the privacy controls is explained by the grant it needs, with a way to
 * System Settings; everything else, and every error elsewhere, shows as it
 * always did.
 */

export type { PrivacyRefusal };

export const OPEN_SETTINGS_LABEL = "Open System Settings";

const REFUSAL_TOAST_MS = 10_000;

/**
 * The privacy grant that refused a file operation on `paths`, or null: off
 * macOS, for any other error, outside the protected places, or when Terax has
 * Full Disk Access.
 */
export async function explainFileError(
  paths: string | readonly string[],
  error: unknown,
): Promise<PrivacyRefusal | null> {
  if (!IS_MAC || !isOperationNotPermitted(error)) return null;
  const { explainRefusal } = await import("./explain");
  return explainRefusal(paths, error);
}

export function openSettingsFor(refusal: PrivacyRefusal): void {
  void openPrivacySettings(refusal.pane).catch((error) =>
    console.error("[mac-privacy] could not open System Settings:", error),
  );
}

type FileErrorToast = {
  /** The file or folder the operation was on; with several, the first protected one counts. */
  path: string | readonly string[];
  error: unknown;
  id?: string | number;
  /** Shown when the error is not a privacy refusal. */
  description?: string;
};

// The latest explanation started per toast id, so a dismissal or a newer error
// is never followed by a stale toast.
const explaining = new Map<string | number, symbol>();

/** `toast.error(title, { id, description })`, explained when macOS privacy refused it. */
export function showFileError(
  title: string,
  { path, error, id, description }: FileErrorToast,
): void {
  // Exactly the call this replaced.
  const plain = () =>
    id === undefined && description === undefined
      ? toast.error(title)
      : toast.error(title, {
          ...(id === undefined ? {} : { id }),
          ...(description === undefined ? {} : { description }),
        });
  // A newer error for the same toast wins over one still being explained.
  if (id !== undefined) explaining.delete(id);
  if (!IS_MAC || !isOperationNotPermitted(error)) {
    plain();
    return;
  }
  const ticket = Symbol();
  if (id !== undefined) explaining.set(id, ticket);
  void explainFileError(path, error).then((refusal) => {
    if (id !== undefined) {
      if (explaining.get(id) !== ticket) return;
      explaining.delete(id);
    }
    if (refusal) showRefusal(title, refusal, id);
    else plain();
  });
}

/** For operations that used to fail quietly: speaks up only for a privacy refusal. */
export function showPrivacyRefusal(
  title: string,
  { path, error }: Pick<FileErrorToast, "path" | "error">,
): void {
  if (!IS_MAC || !isOperationNotPermitted(error)) return;
  void explainFileError(path, error).then((refusal) => {
    if (refusal) showRefusal(title, refusal);
  });
}

/** `toast.dismiss(id)` for a toast `showFileError` shows, even one still being explained. */
export function dismissFileError(id: string | number): void {
  explaining.delete(id);
  toast.dismiss(id);
}

function showRefusal(
  title: string,
  refusal: PrivacyRefusal,
  id?: string | number,
): void {
  toast.error(title, {
    id,
    description: refusal.message,
    duration: REFUSAL_TOAST_MS,
    action: {
      label: OPEN_SETTINGS_LABEL,
      onClick: () => openSettingsFor(refusal),
    },
  });
}
