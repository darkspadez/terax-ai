import { Button } from "@/components/ui/button";
import { Cancel01Icon, Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export type AiInputBarConnectProps = {
  onAdd: () => void;
  /** Hides the bar: without a provider there is no composer, and so no other
   *  close control in the status bar. */
  onClose: () => void;
};

export function AiInputBarConnect({ onAdd, onClose }: AiInputBarConnectProps) {
  return (
    <div className="shrink-0 border-t border-border/60 bg-foreground/[0.02] px-3 py-2">
      <div className="flex h-10 items-center justify-between gap-3 rounded-lg px-3 text-xs">
        <span className="text-muted-foreground">
          Connect any AI provider (or use local models) - your key stays in your
          OS keychain.
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="xs" onClick={onAdd}>
            <HugeiconsIcon icon={Key01Icon} />
            Connect provider
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close AI panel"
            title="Close"
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
        </div>
      </div>
    </div>
  );
}
