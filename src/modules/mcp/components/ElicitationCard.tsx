import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  McpServerIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type ElicitField,
  type ElicitValue,
  type ElicitValues,
  initialValues,
  validateElicitation,
} from "../lib/elicitation";
import type { PendingElicitation } from "../lib/requests";

const INPUT =
  "h-7 w-full rounded-md border bg-background px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

function inputType(field: Extract<ElicitField, { kind: "string" }>): string {
  switch (field.format) {
    case "email":
      return "email";
    case "uri":
      return "url";
    case "date":
      return "date";
    case "date-time":
      return "datetime-local";
    default:
      return "text";
  }
}

function hint(field: ElicitField): string | null {
  if (field.kind === "number") {
    const kind = field.integer ? "A whole number" : "A number";
    if (field.minimum !== undefined && field.maximum !== undefined) {
      return `${kind} from ${field.minimum} to ${field.maximum}.`;
    }
    if (field.minimum !== undefined)
      return `${kind}, ${field.minimum} or more.`;
    if (field.maximum !== undefined)
      return `${kind}, ${field.maximum} or less.`;
    return null;
  }
  if (field.kind === "multi") {
    if (field.minItems !== undefined && field.maxItems !== undefined) {
      return `Choose ${field.minItems} to ${field.maxItems}.`;
    }
    if (field.minItems !== undefined)
      return `Choose at least ${field.minItems}.`;
    if (field.maxItems !== undefined)
      return `Choose at most ${field.maxItems}.`;
  }
  return null;
}

function FieldInput({
  id,
  field,
  value,
  invalid,
  onChange,
  inputRef,
}: {
  id: string;
  field: ElicitField;
  value: ElicitValue | undefined;
  invalid: boolean;
  onChange: (value: ElicitValue) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const border = invalid ? "border-destructive/60" : "border-border";
  switch (field.kind) {
    case "boolean":
      return (
        <input
          id={id}
          ref={inputRef}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="size-3.5 accent-primary"
        />
      );
    case "choice":
      return (
        <select
          id={id}
          value={typeof value === "string" ? value : ""}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
          className={cn(INPUT, border, "px-1.5")}
        >
          <option value="" disabled={field.required}>
            {field.required ? "Choose one" : "(none)"}
          </option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "multi": {
      const picked = Array.isArray(value) ? value : [];
      return (
        <div id={id} className="flex flex-col gap-1">
          {field.options.map((o) => (
            <label
              key={o.value}
              className="flex items-center gap-2 text-[12px] text-foreground"
            >
              <input
                type="checkbox"
                checked={picked.includes(o.value)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...picked, o.value]
                      : picked.filter((v) => v !== o.value),
                  )
                }
                className="size-3.5 accent-primary"
              />
              <span className="min-w-0 truncate">{o.label}</span>
            </label>
          ))}
        </div>
      );
    }
    case "number":
      return (
        <input
          id={id}
          ref={inputRef}
          value={typeof value === "string" ? value : ""}
          inputMode={field.integer ? "numeric" : "decimal"}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
          className={cn(INPUT, border, "tabular-nums")}
        />
      );
    case "string":
      return (
        <input
          id={id}
          ref={inputRef}
          type={inputType(field)}
          value={typeof value === "string" ? value : ""}
          maxLength={field.maxLength}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
          className={cn(INPUT, border)}
        />
      );
  }
}

/**
 * A server's request for information (form-mode elicitation) in the chat:
 * which server asks, its message as its own words, the form, and the three
 * answers of the spec. Nothing is sent until the user submits.
 */
export function ElicitationCard({ request }: { request: PendingElicitation }) {
  const [values, setValues] = useState<ElicitValues>(() =>
    initialValues(request.fields),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus({ preventScroll: true });
  }, []);

  // The server cancelled its request or stopped: the form goes with it.
  useEffect(() => {
    const onAbort = () =>
      toast.message(
        `${request.serverName} withdrew its request for information`,
      );
    request.signal.addEventListener("abort", onAbort);
    return () => request.signal.removeEventListener("abort", onAbort);
  }, [request.signal, request.serverName]);

  const submit = () => {
    const checked = validateElicitation(request.fields, values);
    setErrors(checked.errors);
    if (checked.content) {
      request.answer({ action: "accept", content: checked.content });
    }
  };

  return (
    <div
      role="dialog"
      aria-label={`${request.serverName} asks for information`}
      className="rounded-lg border border-border bg-card shadow-sm"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          request.answer({ action: "cancel" });
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500 oarlock-attention-pulse" />
        <HugeiconsIcon
          icon={McpServerIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
          {request.serverName} asks for information
        </span>
        <button
          type="button"
          onClick={() => request.answer({ action: "cancel" })}
          aria-label="Dismiss"
          title="Dismiss (the server is told you did not answer)"
          className="ml-auto grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
        </button>
      </div>
      <form
        className="space-y-2.5 px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {request.message ? (
          <div className="space-y-1">
            <div className="text-[10px] font-medium text-muted-foreground">
              The MCP server {request.serverName} writes:
            </div>
            <div className="max-h-32 overflow-y-auto rounded-md bg-muted/60 px-2 py-1.5 text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-foreground">
              {request.message}
            </div>
          </div>
        ) : null}
        {request.fields.map((field, index) => {
          const id = `${request.id}-${index}`;
          const note = field.description ?? hint(field);
          return (
            <div
              key={field.name}
              className={cn(
                "space-y-1",
                field.kind === "boolean" &&
                  "flex flex-row-reverse items-start justify-end gap-2 space-y-0",
              )}
            >
              <label
                htmlFor={field.kind === "multi" ? undefined : id}
                className="block min-w-0 text-[11px] font-medium text-foreground"
              >
                {field.label}
                {field.required ? (
                  <span className="ml-1 font-normal text-muted-foreground">
                    (required)
                  </span>
                ) : null}
                {field.kind === "boolean" && note ? (
                  <span className="block font-normal text-[10.5px] text-muted-foreground">
                    {note}
                  </span>
                ) : null}
              </label>
              {field.kind !== "boolean" && note ? (
                <div className="text-[10.5px] text-muted-foreground">
                  {note}
                </div>
              ) : null}
              <FieldInput
                id={id}
                field={field}
                value={values[field.name]}
                invalid={Boolean(errors[field.name])}
                inputRef={index === 0 ? first : undefined}
                onChange={(value) => {
                  setValues((v) => ({ ...v, [field.name]: value }));
                  setErrors((e) => {
                    if (!e[field.name]) return e;
                    const rest = { ...e };
                    delete rest[field.name];
                    return rest;
                  });
                }}
              />
              {errors[field.name] ? (
                <div className="text-[10.5px] text-destructive">
                  {errors[field.name]}
                </div>
              ) : null}
            </div>
          );
        })}
        <div className="text-[10.5px] leading-relaxed text-muted-foreground">
          What you submit goes to {request.serverName}. Only answer a server you
          trust, and never enter passwords, keys or payment details here.
        </div>
        <div className="flex items-center justify-end gap-1.5 border-t border-border/60 pt-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => request.answer({ action: "decline" })}
            className="h-7 gap-1.5 text-[11px]"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            Decline
          </Button>
          <Button type="submit" size="sm" className="h-7 gap-1.5 text-[11px]">
            <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
            Submit
          </Button>
        </div>
      </form>
    </div>
  );
}
