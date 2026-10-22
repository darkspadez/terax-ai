import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  ArrowDown01Icon,
  BrainIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ModelInfo } from "../config";
import { setModelReasoningEffort } from "../lib/modelPrefs";
import {
  effectiveReasoningEffort,
  type ReasoningEffort,
  reasoningEfforts,
} from "../lib/reasoningEffort";

const EFFORT_COPY: Record<ReasoningEffort, { label: string; hint: string }> = {
  off: { label: "Off", hint: "No extended thinking, or the least it allows" },
  low: { label: "Low", hint: "Brief thinking, fastest and cheapest" },
  medium: { label: "Medium", hint: "Balanced thinking" },
  high: { label: "High", hint: "Thorough thinking, slower and costlier" },
};

/** The reasoning effort of the selected model, remembered per model. Hidden
 *  for models that cannot take one. */
export function ReasoningEffortPicker({ model }: { model: ModelInfo }) {
  const stored = usePreferencesStore((s) => s.reasoningEffortByModel[model.id]);
  const levels = reasoningEfforts(model);
  if (levels.length === 0) return null;
  const effort = effectiveReasoningEffort(model, stored);
  const label = effort ? EFFORT_COPY[effort].label : "Default";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="my-1 h-5.5 gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title={
            effort
              ? `Reasoning effort: ${label}`
              : "Reasoning effort: the model's default"
          }
        >
          <HugeiconsIcon icon={BrainIcon} size={12} strokeWidth={1.75} />
          {label}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Reasoning effort · {model.label}
        </div>
        {levels.map((level) => (
          <DropdownMenuItem
            key={level}
            onSelect={() => void setModelReasoningEffort(model.id, level)}
            className={cn(
              "flex items-start gap-2 pr-2 text-[12px]",
              level === effort && "bg-accent/40",
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{EFFORT_COPY[level].label}</span>
              <span className="text-[10.5px] text-muted-foreground">
                {EFFORT_COPY[level].hint}
              </span>
            </span>
            {level === effort ? (
              <HugeiconsIcon
                icon={Tick02Icon}
                size={12}
                strokeWidth={2}
                className="mt-0.5 shrink-0 text-foreground"
              />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
