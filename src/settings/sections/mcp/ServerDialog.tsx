import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type {
  McpServerConfig,
  McpTransportType,
} from "@/modules/mcp/lib/config";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import {
  type DraftErrors,
  draftErrors,
  hasErrors,
  newRow,
  type ServerDraft,
  type ValueRow,
} from "./draft";

const TYPES: { type: McpTransportType; label: string; hint: string }[] = [
  {
    type: "stdio",
    label: "Local command",
    hint: "A program Terax starts and talks to over stdin and stdout.",
  },
  {
    type: "http",
    label: "Streamable HTTP",
    hint: "A remote server's MCP endpoint, reached through Terax's network gate.",
  },
  {
    type: "sse",
    label: "SSE (legacy)",
    hint: "An older remote server that uses the HTTP+SSE transport.",
  },
];

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px]">{label}</Label>
      {children}
      {error ? (
        <span className="text-[10.5px] text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-[10.5px] text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

function ValueRows({
  rows,
  onChange,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  rows: ValueRow[];
  onChange: (rows: ValueRow[]) => void;
  namePlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  const update = (key: string, change: (row: ValueRow) => ValueRow) =>
    onChange(rows.map((r) => (r.key === key ? change(r) : r)));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-1.5">
          <Input
            value={row.name}
            onChange={(e) =>
              // A saved secret belongs to its name: renaming needs a new value.
              update(row.key, (r) => ({
                ...r,
                name: e.target.value,
                saved: false,
              }))
            }
            placeholder={namePlaceholder}
            spellCheck={false}
            className="h-7 w-40 shrink-0 font-mono text-[11px]"
            aria-label="Name"
          />
          <Input
            type={row.secret ? "password" : "text"}
            value={row.value}
            onChange={(e) =>
              update(row.key, (r) => ({ ...r, value: e.target.value }))
            }
            placeholder={
              row.secret && row.saved
                ? "Saved in the keychain; type to replace"
                : valuePlaceholder
            }
            spellCheck={false}
            autoComplete="off"
            className="h-7 min-w-0 flex-1 font-mono text-[11px]"
            aria-label="Value"
          />
          <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground">
            <Switch
              checked={row.secret}
              onCheckedChange={(secret) =>
                update(row.key, (r) => ({ ...r, secret, saved: false }))
              }
              aria-label="Secret"
            />
            Secret
          </span>
          <button
            type="button"
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
            onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
            title="Remove"
          >
            <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, newRow()])}
        className="flex w-fit cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={Add01Icon} size={11} strokeWidth={2} />
        {addLabel}
      </button>
    </div>
  );
}

/**
 * The sign-in client of a remote server: empty unless the server's sign-in
 * service needs a client the user registered there.
 */
function SignInClient({
  draft,
  error,
  patch,
}: {
  draft: ServerDraft;
  error?: string;
  patch: (change: Partial<ServerDraft>) => void;
}) {
  const configured = Boolean(
    draft.oauthClientId ||
      draft.oauthScopes ||
      draft.oauthPort ||
      draft.oauthSecretSaved,
  );
  const [open, setOpen] = useState(configured);
  const port = draft.oauthPort.trim() || "<any port>";
  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <Label className="text-[11px]">Sign-in</Label>
        <span className="text-[10.5px] text-muted-foreground">
          If the server asks you to sign in, Terax registers itself with its
          sign-in service; sign in from the server's card.{" "}
          <button
            type="button"
            className="cursor-pointer text-foreground underline-offset-2 hover:underline"
            onClick={() => setOpen(true)}
          >
            Use a client you registered
          </button>
        </span>
      </div>
    );
  }
  return (
    <Field
      label="Sign-in client"
      error={error}
      hint={`For a sign-in service that needs a client you registered there. Register http://127.0.0.1:${port}/callback as its redirect URI. Leave the client ID empty to let Terax register itself.`}
    >
      <div className="grid grid-cols-2 gap-1.5">
        <Input
          value={draft.oauthClientId}
          onChange={(e) => patch({ oauthClientId: e.target.value })}
          placeholder="Client ID"
          spellCheck={false}
          className="h-7 font-mono text-[11px]"
          aria-label="Client ID"
        />
        <div className="flex items-center gap-1">
          <Input
            type="password"
            value={draft.oauthSecret}
            onChange={(e) => patch({ oauthSecret: e.target.value })}
            placeholder={
              draft.oauthSecretSaved
                ? "Secret saved; type to replace"
                : "Client secret (optional)"
            }
            spellCheck={false}
            autoComplete="off"
            className="h-7 min-w-0 flex-1 font-mono text-[11px]"
            aria-label="Client secret"
          />
          {draft.oauthSecretSaved ? (
            <button
              type="button"
              className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
              onClick={() =>
                patch({ oauthSecretSaved: false, oauthSecret: "" })
              }
              title="Remove the saved secret"
            >
              <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
        <Input
          value={draft.oauthScopes}
          onChange={(e) => patch({ oauthScopes: e.target.value })}
          placeholder="Scopes (optional, space-separated)"
          spellCheck={false}
          className="h-7 font-mono text-[11px]"
          aria-label="Scopes"
        />
        <Input
          value={draft.oauthPort}
          onChange={(e) => patch({ oauthPort: e.target.value })}
          placeholder="Callback port (optional)"
          inputMode="numeric"
          spellCheck={false}
          className="h-7 font-mono text-[11px]"
          aria-label="Callback port"
        />
      </div>
    </Field>
  );
}

/** Adds or edits one server. `onSave` writes it; an error stays in the dialog. */
export function ServerDialog({
  draft: initial,
  others,
  onSave,
  onClose,
}: {
  draft: ServerDraft;
  others: readonly McpServerConfig[];
  onSave: (draft: ServerDraft) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const formId = useId();
  const errors: DraftErrors = draftErrors(draft, others);
  const shown: DraftErrors = touched ? errors : {};
  const patch = (change: Partial<ServerDraft>) =>
    setDraft((d) => ({ ...d, ...change }));

  const save = async () => {
    setTouched(true);
    if (hasErrors(errors)) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {initial.base ? `Edit ${initial.base.name}` : "Add MCP server"}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            Secret values are kept in your system keychain. Terax reads them
            only when it starts the server or sends it a request.
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field
            label="Name"
            error={shown.name}
            hint="Shown in Settings and to the agent, as mcp__name__tool."
          >
            <Input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="github"
              className="h-7 text-xs"
              autoFocus
            />
          </Field>
          <Field
            label="Type"
            hint={TYPES.find((t) => t.type === draft.type)?.hint}
          >
            <div className="flex w-fit rounded-md border border-border/70 p-0.5">
              {TYPES.map(({ type, label }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => patch({ type })}
                  className={cn(
                    "cursor-pointer rounded px-2.5 py-1 text-[11px] transition-colors",
                    draft.type === type
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          {draft.type === "stdio" ? (
            <>
              <Field
                label="Command"
                error={shown.command}
                hint="The program and its arguments, as you would type them. Found through the PATH of your terminal shell; a relative path (./serve.sh) in the working folder."
              >
                <Input
                  value={draft.commandLine}
                  onChange={(e) => patch({ commandLine: e.target.value })}
                  placeholder="npx -y @modelcontextprotocol/server-everything"
                  spellCheck={false}
                  className="h-7 font-mono text-[11px]"
                />
              </Field>
              <Field
                label="Working folder (optional)"
                error={shown.cwd}
                hint="An absolute path. Empty starts it in your home folder."
              >
                <Input
                  value={draft.cwd}
                  onChange={(e) => patch({ cwd: e.target.value })}
                  placeholder="/path/to/folder"
                  spellCheck={false}
                  className="h-7 font-mono text-[11px]"
                />
              </Field>
              <Field
                label="Environment variables"
                error={shown.values ?? shown.secrets}
              >
                <ValueRows
                  rows={draft.env}
                  onChange={(env) => patch({ env })}
                  namePlaceholder="API_KEY"
                  valuePlaceholder="value"
                  addLabel="Add variable"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL" error={shown.url}>
                <Input
                  value={draft.url}
                  onChange={(e) => patch({ url: e.target.value })}
                  placeholder={
                    draft.type === "sse"
                      ? "https://example.com/sse"
                      : "https://example.com/mcp"
                  }
                  spellCheck={false}
                  className="h-7 font-mono text-[11px]"
                />
              </Field>
              <Field
                label="Headers"
                error={shown.values ?? shown.secrets}
                hint="For an API key, add Authorization (Bearer ...) or the header the service names, and mark it secret."
              >
                <ValueRows
                  rows={draft.headers}
                  onChange={(headers) => patch({ headers })}
                  namePlaceholder="Authorization"
                  valuePlaceholder="Bearer ..."
                  addLabel="Add header"
                />
              </Field>
              <SignInClient draft={draft} error={shown.oauth} patch={patch} />
            </>
          )}
        </form>
        {saveError ? (
          <div className="text-[11px] text-destructive">{saveError}</div>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" type="submit" form={formId} disabled={saving}>
            {initial.base ? "Save" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
