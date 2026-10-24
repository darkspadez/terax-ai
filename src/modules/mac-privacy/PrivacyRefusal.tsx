import { Button } from "@/components/ui/button";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { type CSSProperties, useEffect, useState } from "react";
import {
  explainFileError,
  OPEN_SETTINGS_LABEL,
  openSettingsFor,
  type PrivacyRefusal,
} from "./fileErrors";
import {
  errorText,
  isOperationNotPermitted,
} from "./lib/operationNotPermitted";

type Explained = { key: string; refusal: PrivacyRefusal | null };

/**
 * The privacy grant behind an error shown in place (a pane, a row, a panel),
 * once known: null meanwhile, for any other error and off macOS, so the
 * caller shows its usual message.
 */
export function usePrivacyRefusal(
  path: string | readonly string[] | null,
  error: unknown,
): PrivacyRefusal | null {
  const key =
    IS_MAC && path !== null && error != null && isOperationNotPermitted(error)
      ? JSON.stringify([path, errorText(error)])
      : null;
  const [explained, setExplained] = useState<Explained | null>(null);

  useEffect(() => {
    if (key === null) return;
    const [paths, text] = JSON.parse(key) as [string | string[], string];
    let alive = true;
    void explainFileError(paths, text).then((refusal) => {
      if (alive) setExplained({ key, refusal });
    });
    return () => {
      alive = false;
    };
  }, [key]);

  return explained !== null && explained.key === key ? explained.refusal : null;
}

export function OpenPrivacySettingsButton({
  refusal,
  className,
}: {
  refusal: PrivacyRefusal;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className={className}
      onClick={() => openSettingsFor(refusal)}
    >
      {OPEN_SETTINGS_LABEL}
    </Button>
  );
}

/** A privacy refusal in place of an error message: what is missing, and the way to allow it. */
export function PrivacyRefusalNotice({
  refusal,
  title,
  className,
}: {
  refusal: PrivacyRefusal;
  title?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center gap-2 text-center", className)}
    >
      {title ? <div className="text-sm text-foreground">{title}</div> : null}
      <div className="max-w-80 text-xs leading-relaxed text-muted-foreground">
        {refusal.message}
      </div>
      <OpenPrivacySettingsButton refusal={refusal} />
    </div>
  );
}

/** A privacy refusal on one line, for a row of the file tree. */
export function PrivacyRefusalLine({
  refusal,
  className,
  style,
}: {
  refusal: PrivacyRefusal;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      role="alert"
      title={refusal.message}
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      style={style}
    >
      <span className="min-w-0 truncate">
        Blocked by macOS privacy settings
      </span>
      <button
        type="button"
        title={OPEN_SETTINGS_LABEL}
        className="shrink-0 rounded px-1 text-foreground hover:bg-accent"
        onClick={() => openSettingsFor(refusal)}
      >
        Allow…
      </button>
    </div>
  );
}
