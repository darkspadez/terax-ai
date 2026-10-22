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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { GitBranchEntry, GitWorktreeEntry } from "@/modules/ai/lib/native";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  ArrowDown01Icon,
  FolderAddIcon,
  FolderRemoveIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
  gitWorktreeAdd,
  gitWorktreeRemove,
  type WorktreeAddResult,
} from "./worktreeCommands";
import {
  branchesFreeForWorktree,
  branchNameProblem,
  defaultWorktreePath,
  mainWorktreeRoot,
  type PathStyle,
  removeWithChangesMessage,
  worktreeBranchLabel,
  worktreeFolderProblem,
  worktreeName,
  worktreeRemoveBlocker,
} from "./worktrees";

/** No branch can be called `HEAD`, so it stands for "based on HEAD" among them. */
const BASE_HEAD = "HEAD";

function workspacePathStyle(): PathStyle {
  return currentWorkspaceEnv().kind === "local" && IS_WINDOWS
    ? "windows"
    : "posix";
}

function Field({
  id,
  label,
  message,
  error = false,
  children,
}: {
  id: string;
  label: string;
  message?: string | null;
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <label
        htmlFor={id}
        className="text-xs leading-none font-medium text-muted-foreground"
      >
        {label}
      </label>
      {children}
      {message ? (
        <p
          id={`${id}-message`}
          className={cn(
            "text-xs leading-snug",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** A one-of-many branch choice, styled as the inputs beside it. */
function BranchPicker({
  id,
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly { value: string; label: string }[];
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          className="flex h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-1.5 rounded-3xl border border-transparent bg-input/50 px-3 text-left text-sm outline-none transition-[color,box-shadow,background-color] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={cn("truncate", !current && "text-muted-foreground")}>
            {current?.label ?? placeholder}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={14}
            strokeWidth={2}
            className="shrink-0 text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <DropdownMenuItem
              key={option.value}
              role="menuitemradio"
              aria-checked={selected}
              onSelect={() => onChange(option.value)}
              className="flex cursor-pointer items-center gap-2 text-[13px]"
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {selected ? (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  size={14}
                  strokeWidth={1.8}
                  className="shrink-0"
                />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One half of the new-or-existing switch: a radio input styled as a segment. */
function ModeOption({
  name,
  checked,
  disabled,
  title,
  onSelect,
  children,
}: {
  name: string;
  checked: boolean;
  disabled: boolean;
  title?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <label
      title={title}
      className={cn(
        "flex cursor-pointer items-center justify-center rounded-full text-sm font-medium transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        checked
          ? "bg-background text-foreground shadow-sm dark:bg-input/30"
          : "text-foreground/60 hover:text-foreground",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="sr-only"
      />
      {children}
    </label>
  );
}

type NewWorktreeProps = {
  repoRoot: string;
  branches: readonly GitBranchEntry[];
  worktrees: readonly GitWorktreeEntry[];
  /** What HEAD is on: the current branch, or "detached". */
  headLabel: string;
  onCreated: (result: WorktreeAddResult) => void;
};

/**
 * Creates a worktree for a new branch (from HEAD or a chosen branch) or for
 * a local branch no worktree has checked out, in a folder that defaults to
 * `<repository folder>-<branch>` beside the repository.
 */
export function NewWorktreeDialog({
  open,
  onOpenChange,
  ...props
}: NewWorktreeProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // git keeps running once started; the result still has to land.
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
        <NewWorktreeForm
          {...props}
          onBusyChange={setBusy}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

// Mounted with the dialog's content, so every opening starts fresh.
function NewWorktreeForm({
  repoRoot,
  branches,
  worktrees,
  headLabel,
  onCreated,
  onBusyChange,
  onCancel,
}: NewWorktreeProps & {
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const style = useMemo(workspacePathStyle, []);
  const localNames = useMemo(
    () => branches.filter((b) => !b.isDetached).map((b) => b.name),
    [branches],
  );
  const free = useMemo(() => branchesFreeForWorktree(branches), [branches]);
  const baseOptions = useMemo(
    () => [
      { value: BASE_HEAD, label: `HEAD (${headLabel})` },
      ...localNames.map((branch) => ({ value: branch, label: branch })),
    ],
    [headLabel, localNames],
  );
  const freeOptions = useMemo(
    () => free.map((branch) => ({ value: branch, label: branch })),
    [free],
  );
  const mainRoot = mainWorktreeRoot(worktrees) ?? repoRoot;

  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [base, setBase] = useState(BASE_HEAD);
  const [existing, setExisting] = useState(() => free[0] ?? "");
  // null: the folder follows the branch.
  const [editedFolder, setEditedFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const branchName = mode === "new" ? name.trim() : existing;
  const defaultFolder = branchName
    ? defaultWorktreePath(mainRoot, branchName)
    : "";
  const folder = editedFolder ?? defaultFolder;
  const branchProblem =
    mode === "new"
      ? branchNameProblem(branchName, localNames)
      : existing
        ? null
        : "Choose a branch.";
  const folderProblem = worktreeFolderProblem(folder, style);
  const canCreate = !busy && !branchProblem && !folderProblem;
  const shownBranchProblem = mode === "new" && name ? branchProblem : null;
  const shownFolderProblem =
    editedFolder !== null || folder ? folderProblem : null;

  const setWorking = (working: boolean) => {
    setBusy(working);
    onBusyChange(working);
  };

  const submit = async () => {
    if (!canCreate) return;
    setWorking(true);
    setError(null);
    try {
      const result = await gitWorktreeAdd(
        repoRoot,
        mode === "new"
          ? {
              kind: "new",
              name: branchName,
              base: base === BASE_HEAD ? null : base,
            }
          : { kind: "existing", name: branchName },
        folder.trim(),
      );
      setWorking(false);
      onCreated(result);
    } catch (e) {
      setWorking(false);
      setError(String(e));
    }
  };

  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-1.75">
          <HugeiconsIcon icon={FolderAddIcon} size={16} strokeWidth={1.75} />
          New Worktree
        </DialogTitle>
        <DialogDescription>
          Check out a branch in a folder of its own, next to this one, to work
          on it in parallel.
        </DialogDescription>
      </DialogHeader>

      <fieldset className="grid h-9 grid-cols-2 rounded-full bg-muted p-1">
        <legend className="sr-only">Branch</legend>
        <ModeOption
          name={`${ids}-mode`}
          checked={mode === "new"}
          disabled={busy}
          onSelect={() => {
            setMode("new");
            setError(null);
          }}
        >
          New branch
        </ModeOption>
        <ModeOption
          name={`${ids}-mode`}
          checked={mode === "existing"}
          disabled={busy || free.length === 0}
          title={
            free.length === 0
              ? "Every local branch is checked out in a worktree already."
              : undefined
          }
          onSelect={() => {
            setMode("existing");
            setError(null);
          }}
        >
          Existing branch
        </ModeOption>
      </fieldset>

      {mode === "new" ? (
        <div className="grid gap-4">
          <Field
            id={`${ids}-name`}
            label="Branch name"
            message={shownBranchProblem}
            error
          >
            <Input
              id={`${ids}-name`}
              autoFocus
              value={name}
              disabled={busy}
              placeholder="feature/name"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-invalid={shownBranchProblem ? true : undefined}
              aria-describedby={
                shownBranchProblem ? `${ids}-name-message` : undefined
              }
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
          </Field>
          <Field id={`${ids}-base`} label="Based on">
            <BranchPicker
              id={`${ids}-base`}
              value={base}
              options={baseOptions}
              placeholder="HEAD"
              disabled={busy}
              onChange={setBase}
            />
          </Field>
        </div>
      ) : (
        <Field
          id={`${ids}-existing`}
          label="Branch"
          message="Only branches no worktree has checked out are listed."
        >
          <BranchPicker
            id={`${ids}-existing`}
            value={existing}
            options={freeOptions}
            placeholder="Choose a branch"
            disabled={busy}
            onChange={(value) => {
              setExisting(value);
              setError(null);
            }}
          />
        </Field>
      )}

      <Field
        id={`${ids}-folder`}
        label="Folder"
        message={shownFolderProblem ?? "A new folder, or an empty one."}
        error={shownFolderProblem !== null}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Input
            id={`${ids}-folder`}
            value={folder}
            disabled={busy}
            placeholder={defaultWorktreePath(mainRoot, "branch")}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={shownFolderProblem ? true : undefined}
            aria-describedby={`${ids}-folder-message`}
            className="font-mono text-xs md:text-xs"
            onChange={(event) => {
              setEditedFolder(event.target.value);
              setError(null);
            }}
          />
          {editedFolder !== null && editedFolder !== defaultFolder ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => setEditedFolder(null)}
              title={defaultFolder || undefined}
            >
              Default
            </Button>
          ) : null}
        </div>
      </Field>

      {error ? (
        <p role="alert" className="text-xs leading-snug text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!canCreate}>
          {busy ? (
            <>
              <Spinner className="size-3.5" />
              Creating…
            </>
          ) : (
            "Create Worktree"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

type RemoveWorktreeProps = {
  repoRoot: string;
  /** The linked worktrees that are not open; locked ones are shown but cannot be picked. */
  worktrees: readonly GitWorktreeEntry[];
  onRemoved: (worktree: GitWorktreeEntry) => void;
};

/**
 * Removes a linked worktree. One with uncommitted or untracked changes is
 * only removed after a second confirmation, which forces it.
 */
export function RemoveWorktreeDialog({
  open,
  onOpenChange,
  ...props
}: RemoveWorktreeProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
        <RemoveWorktreeForm
          {...props}
          onBusyChange={setBusy}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function RemoveWorktreeForm({
  repoRoot,
  worktrees,
  onRemoved,
  onBusyChange,
  onCancel,
}: RemoveWorktreeProps & {
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
}) {
  const group = useId();
  const [selected, setSelected] = useState<string | null>(
    () => worktrees.find((wt) => !worktreeRemoveBlocker(wt))?.path ?? null,
  );
  // Set once an unforced removal found changes: the confirm-force step.
  const [changes, setChanges] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = worktrees.find((wt) => wt.path === selected) ?? null;

  const remove = async (force: boolean) => {
    if (!target || busy) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const result = await gitWorktreeRemove(repoRoot, target.path, force);
      setBusy(false);
      onBusyChange(false);
      if (result.removed) {
        onRemoved(target);
      } else {
        setChanges(result.changes);
      }
    } catch (e) {
      setBusy(false);
      onBusyChange(false);
      setError(String(e));
    }
  };

  const footerError = error ? (
    <p role="alert" className="text-xs leading-snug text-destructive">
      {error}
    </p>
  ) : null;

  if (target && changes !== null) {
    return (
      <div className="grid gap-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon
              icon={FolderRemoveIcon}
              size={16}
              strokeWidth={1.75}
            />
            Remove worktree with changes?
          </DialogTitle>
          <DialogDescription>
            {removeWithChangesMessage(target, changes)}
          </DialogDescription>
        </DialogHeader>
        {footerError}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setChanges(null);
              setError(null);
            }}
          >
            Back
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void remove(true)}
          >
            {busy ? <Spinner className="size-3.5" /> : null}
            Remove Anyway
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-1.75">
          <HugeiconsIcon icon={FolderRemoveIcon} size={16} strokeWidth={1.75} />
          Remove Worktree
        </DialogTitle>
        <DialogDescription>
          Deletes the worktree's folder. Its branch and commits stay in the
          repository.
        </DialogDescription>
      </DialogHeader>
      <fieldset className="-mx-1 grid max-h-64 min-w-0 gap-1 overflow-y-auto px-1 py-0.5">
        <legend className="sr-only">Worktree to remove</legend>
        {worktrees.map((wt) => {
          const blocker = worktreeRemoveBlocker(wt);
          const checked = wt.path === selected;
          return (
            <label
              key={wt.path}
              title={wt.path}
              className={cn(
                "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-2xl border px-3 py-2 transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
                checked
                  ? "border-primary/50 bg-primary/5"
                  : "border-border/60 hover:bg-muted/50",
              )}
            >
              <input
                type="radio"
                name={group}
                value={wt.path}
                checked={checked}
                disabled={busy || blocker !== null}
                onChange={() => {
                  setSelected(wt.path);
                  setError(null);
                }}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                  checked ? "border-primary" : "border-muted-foreground/50",
                )}
              >
                {checked ? (
                  <span className="size-1.5 rounded-full bg-primary" />
                ) : null}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium text-foreground">
                  {worktreeName(wt.path)}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {worktreeBranchLabel(wt)}
                </span>
                <span className="truncate font-mono text-[10.5px] text-muted-foreground/80">
                  {wt.path}
                </span>
                {blocker ? (
                  <span className="text-xs leading-snug text-muted-foreground">
                    {blocker}
                  </span>
                ) : wt.prunable ? (
                  <span className="text-xs leading-snug text-muted-foreground">
                    Its folder is gone already; removing clears git's record of
                    it.
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      {footerError}
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={busy || !target}
          onClick={() => void remove(false)}
        >
          {busy ? <Spinner className="size-3.5" /> : null}
          Remove
        </Button>
      </DialogFooter>
    </div>
  );
}
