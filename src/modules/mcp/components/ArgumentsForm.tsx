import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { McpServerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import {
  type ArgumentsFormRequest,
  missingArguments,
} from "../lib/argumentsForm";

const SUGGESTIONS_SHOWN = 8;
const COMPLETE_DELAY_MS = 200;

/**
 * The composer's form for an MCP prompt's arguments or a resource
 * template's variables, in the composer's popover. Suggestions come from the
 * server (`completion/complete`) when it offers them; they only fill fields.
 */
export function McpArgumentsForm({ form }: { form: ArgumentsFormRequest }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((f) => [f.name, ""])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const firstInput = useRef<HTMLInputElement>(null);
  const askSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    firstInput.current?.focus();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      askSeq.current += 1;
    };
  }, []);

  const askSuggestions = (
    field: string,
    value: string,
    all: Record<string, string>,
  ) => {
    const complete = form.complete;
    if (!complete) return;
    if (timer.current) clearTimeout(timer.current);
    const seq = ++askSeq.current;
    timer.current = setTimeout(() => {
      const context = { ...all };
      delete context[field];
      void complete(field, value, context).then((found) => {
        if (askSeq.current !== seq) return;
        setSuggestions(
          found.filter((s) => s !== value).slice(0, SUGGESTIONS_SHOWN),
        );
        setActive(-1);
      });
    }, COMPLETE_DELAY_MS);
  };

  const setValue = (field: string, value: string) => {
    const next = { ...values, [field]: value };
    setValues(next);
    setErrors((e) => {
      if (!e[field]) return e;
      const rest = { ...e };
      delete rest[field];
      return rest;
    });
    askSuggestions(field, value, next);
  };

  const closeSuggestions = () => {
    askSeq.current += 1;
    setSuggestions([]);
    setActive(-1);
  };

  const submit = async () => {
    if (submitting) return;
    const missing = missingArguments(form.fields, values);
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    closeSuggestions();
    setSubmitting(true);
    setFailure(null);
    try {
      await form.submit(values);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent, field: string) => {
    const open = focused === field && suggestions.length > 0;
    if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (open && active >= 0) {
        setValue(field, suggestions[active]);
        closeSuggestions();
      } else {
        void submit();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (open) closeSuggestions();
      else if (!submitting) form.cancel();
    }
  };

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={6}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      className="w-96 overflow-hidden rounded-lg border border-border bg-card p-0 shadow-xl"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <HugeiconsIcon
            icon={McpServerIcon}
            size={13}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate font-mono text-[12px] font-medium text-foreground">
            {form.title}
          </span>
          <span className="ml-auto shrink-0 truncate text-[10px] text-muted-foreground">
            {form.serverName}
          </span>
        </div>
        <div className="max-h-80 space-y-2.5 overflow-y-auto px-3 py-2.5">
          {form.description ? (
            <p className="line-clamp-3 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {form.description}
            </p>
          ) : null}
          {form.fields.map((field, index) => {
            const id = `${form.id}-${index}`;
            const showSuggestions =
              focused === field.name && suggestions.length > 0;
            return (
              <div key={field.name} className="space-y-1">
                <label
                  htmlFor={id}
                  className="flex items-baseline gap-1 text-[11px] font-medium text-foreground"
                >
                  <span className="truncate">{field.label}</span>
                  {field.required ? (
                    <span className="text-muted-foreground">(required)</span>
                  ) : null}
                </label>
                {field.description ? (
                  <div className="line-clamp-2 text-[10.5px] text-muted-foreground">
                    {field.description}
                  </div>
                ) : null}
                <div className="relative">
                  <input
                    id={id}
                    ref={index === 0 ? firstInput : undefined}
                    value={values[field.name] ?? ""}
                    disabled={submitting}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={errors[field.name] ? true : undefined}
                    onChange={(e) => setValue(field.name, e.target.value)}
                    onFocus={() => {
                      setFocused(field.name);
                      closeSuggestions();
                      askSuggestions(
                        field.name,
                        values[field.name] ?? "",
                        values,
                      );
                    }}
                    onBlur={() => {
                      setFocused((f) => (f === field.name ? null : f));
                    }}
                    onKeyDown={(e) => onKeyDown(e, field.name)}
                    className={cn(
                      "h-7 w-full rounded-md border bg-background px-2 text-[12px] outline-none",
                      "focus-visible:ring-1 focus-visible:ring-ring",
                      errors[field.name]
                        ? "border-destructive/60"
                        : "border-border",
                    )}
                  />
                  {showSuggestions ? (
                    <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-lg">
                      {suggestions.map((s, i) => (
                        <li key={s}>
                          <button
                            type="button"
                            // Keeps the field focused: the pick lands in it.
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setValue(field.name, s);
                              closeSuggestions();
                            }}
                            onMouseEnter={() => setActive(i)}
                            className={cn(
                              "block w-full truncate px-2 py-1 text-left font-mono text-[11px]",
                              i === active ? "bg-accent" : "hover:bg-accent/60",
                            )}
                          >
                            {s}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                {errors[field.name] ? (
                  <div className="text-[10.5px] text-destructive">
                    {errors[field.name]}
                  </div>
                ) : null}
              </div>
            );
          })}
          {failure ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] whitespace-pre-wrap text-destructive">
              {failure}
            </div>
          ) : null}
          <div className="text-[10.5px] text-muted-foreground">
            What the server returns is its own text, sent as coming from{" "}
            {form.serverName}.
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={submitting}
            onClick={() => form.cancel()}
            className="h-7 text-[11px]"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={submitting}
            className="h-7 gap-1.5 text-[11px]"
          >
            {submitting ? <Spinner className="size-3" /> : null}
            {form.submitLabel}
          </Button>
        </div>
      </form>
    </PopoverContent>
  );
}
