import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  FlashIcon,
  Settings01Icon,
  Shield01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { APPROVAL_MODE_OPTIONS } from "../lib/approvalMode";
import { useActiveApprovalMode, useChatStore } from "../store/chatStore";

/** The composer's approval mode for the open conversation: a menu while
 *  tools ask, and an always-visible chip that turns it off while they don't. */
export function ApprovalModeControl() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const mode = useActiveApprovalMode();
  const setMode = useChatStore((s) => s.setSessionApprovalMode);
  if (!sessionId) return null;

  if (mode === "auto") {
    return <AutoApproveChip onTurnOff={() => setMode(sessionId, "ask")} />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="outline"
          className="flex h-6 items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 text-[10.5px] text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
          title="Approvals: edits and commands ask first"
        >
          <HugeiconsIcon icon={Shield01Icon} size={11} strokeWidth={1.75} />
          <span>Ask</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={10}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          This chat
        </div>
        {APPROVAL_MODE_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.mode}
            onSelect={() => setMode(sessionId, option.mode)}
            className={cn(
              "flex items-start gap-2 pr-2 text-[12px]",
              option.mode === mode && "bg-accent/40",
            )}
          >
            <HugeiconsIcon
              icon={option.mode === "auto" ? FlashIcon : Shield01Icon}
              size={13}
              strokeWidth={1.75}
              className={cn(
                "mt-0.5",
                option.mode === "auto"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground",
              )}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{option.label}</span>
              <span className="text-[10.5px] leading-snug text-muted-foreground">
                {option.description}
              </span>
            </span>
            {option.mode === mode ? (
              <HugeiconsIcon
                icon={Tick02Icon}
                size={12}
                strokeWidth={2}
                className="mt-0.5 shrink-0 text-foreground"
              />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void openSettingsWindow("agents")}
          className="gap-2 text-[12px] text-muted-foreground"
        >
          <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
          Default for new chats…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AutoApproveChip({ onTurnOff }: { onTurnOff: () => void }) {
  return (
    <button
      type="button"
      onClick={onTurnOff}
      title="Auto-approve is on: this chat's edits and commands run without asking. Click to ask first again."
      aria-label="Turn off auto-approve"
      className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-amber-500/45 bg-amber-500/15 px-1.5 text-[10.5px] font-medium text-amber-700 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
    >
      <HugeiconsIcon icon={FlashIcon} size={11} strokeWidth={2} />
      <span>Auto-approve</span>
      <HugeiconsIcon
        icon={Cancel01Icon}
        size={10}
        strokeWidth={2}
        className="opacity-70"
      />
    </button>
  );
}
