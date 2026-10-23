import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  createSkill,
  decideProjectTrust,
  deleteSkill,
  editSkill,
  listAllSkills,
  listProjectTrust,
  onSkillsChanged,
  revokeProjectTrust,
  setSkillEnabled,
} from "@/modules/skills/api";
import {
  overriddenGlobal,
  overridingSkill,
  type SkillGroup,
  skillGroups,
  sourceLabel,
  type TrustBar,
} from "@/modules/skills/settingsView";
import { trustDecisions } from "@/modules/skills/trust";
import {
  type InvalidSkill,
  type ProjectTrustStatus,
  type RecordedTrust,
  type Skill,
  type SkillRef,
  type SkillsSnapshot,
  skillRef,
  type TrustItemKind,
} from "@/modules/skills/types";
import {
  Add01Icon,
  Alert02Icon,
  ArrowDown01Icon,
  Delete02Icon,
  Edit02Icon,
  FileZipIcon,
  GithubIcon,
  ShieldKeyIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  InstallSkillsDialog,
  type InstallSource,
} from "../components/skills/InstallSkillsDialog";
import { NewSkillDialog } from "../components/skills/NewSkillDialog";
import { SectionHeader } from "../components/SectionHeader";

type Notice = { tone: "error" | "info"; text: string };

type PendingDelete = {
  id: string;
  name: string;
  /** The trash refused it: confirm deleting for good. */
  permanent: boolean;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SkillsSection() {
  const [snapshot, setSnapshot] = useState<SkillsSnapshot | null>(null);
  const [recorded, setRecorded] = useState<RecordedTrust[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(false);
  const [installing, setInstalling] = useState<InstallSource | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );

  const refresh = useCallback(async () => {
    try {
      const [next, trust] = await Promise.all([
        listAllSkills(),
        listProjectTrust(),
      ]);
      setSnapshot(next);
      setRecorded(trust);
    } catch (e) {
      setNotice({ tone: "error", text: message(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
    let alive = true;
    let stop: (() => void) | undefined;
    void onSkillsChanged(() => void refresh()).then((unlisten) => {
      if (alive) stop = unlisten;
      else unlisten();
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, [refresh]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (e) {
      setNotice({ tone: "error", text: message(e) });
    }
  };

  // The editor is in the app window: hand the file over, then close Settings
  // so the window with the editor is in front (as theme editing does).
  const edit = (ref: SkillRef) =>
    run(async () => {
      await editSkill(ref);
      await getCurrentWebviewWindow().close();
    });

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { id, name, permanent } = pendingDelete;
    try {
      await deleteSkill(id, permanent);
      setPendingDelete(null);
      setNotice({
        tone: "info",
        text: permanent ? `Deleted ${name}.` : `Moved ${name} to the trash.`,
      });
    } catch (e) {
      const text = message(e);
      if (!permanent && text.startsWith("trash unavailable")) {
        setPendingDelete({ id, name, permanent: true });
      } else {
        setPendingDelete(null);
        setNotice({ tone: "error", text });
      }
    }
  };

  const closeInstall = useCallback(() => setInstalling(null), []);
  const groups = useMemo(
    () => (snapshot ? skillGroups(snapshot) : []),
    [snapshot],
  );
  const teraxNames = useMemo(
    () =>
      new Set(
        (snapshot?.skills ?? [])
          .filter((s) => s.source === "terax")
          .map((s) => s.name)
          .concat(
            (snapshot?.invalid ?? [])
              .filter((s) => s.source === "terax")
              .map((s) => s.dirName),
          ),
      ),
    [snapshot],
  );

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Skills"
        description="Folders of instructions, references and scripts the AI loads when a task calls for them, in the Agent Skills format Claude Code and Codex use. The AI sees each enabled skill's name and description, and reads the rest only when it uses one. Call one yourself with /name in the AI input."
      />

      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        <HugeiconsIcon
          icon={Alert02Icon}
          size={13}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span>
          A skill's scripts run with your rights, outside Terax's folder limits,
          through the AI's shell tool: each command asks first unless the
          conversation is in Auto-approve. A skill's text is input to the AI and
          never changes what needs your approval. Add skills only from sources
          you trust.
        </span>
      </div>

      {notice ? (
        <div
          className={cn(
            "flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-[11.5px]",
            notice.tone === "error"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border/60 bg-card/60",
          )}
        >
          <span className="min-w-0 break-words">{notice.text}</span>
          <button
            type="button"
            className="shrink-0 underline opacity-80 hover:opacity-100"
            onClick={() => setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() => setCreating(true)}
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
          New skill
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-[11px]"
            >
              Install
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={11}
                strokeWidth={1.75}
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem
              className="gap-2 text-[12px]"
              onSelect={() => setInstalling("git")}
            >
              <HugeiconsIcon icon={GithubIcon} size={13} strokeWidth={1.75} />
              From a Git repository…
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2 text-[12px]"
              onSelect={() => setInstalling("zip")}
            >
              <HugeiconsIcon icon={FileZipIcon} size={13} strokeWidth={1.75} />
              From a zip file…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {snapshot === null ? (
        <p className="text-[11.5px] text-muted-foreground">Loading skills…</p>
      ) : (
        groups.map((group) => (
          <SkillGroupSection
            key={group.id}
            group={group}
            snapshot={snapshot}
            onToggle={(skill, on) =>
              void run(() => setSkillEnabled(skill.key, on))
            }
            onEdit={(ref) => void edit(ref)}
            onDelete={(id, name) =>
              setPendingDelete({ id, name, permanent: false })
            }
            onTrust={(status, allow) =>
              void run(() =>
                decideProjectTrust(
                  {
                    root: status.project.root,
                    workspace: status.project.workspace,
                  },
                  trustDecisions(
                    status.items,
                    new Set(allow ? status.items.map((i) => i.kind) : []),
                  ),
                ),
              )
            }
            onRevoke={(key, kinds) =>
              void run(async () => {
                // The bar's items only: the project's .mcp.json is MCP's.
                for (const kind of kinds) await revokeProjectTrust(key, kind);
              })
            }
          />
        ))
      )}

      <TrustedProjects
        recorded={recorded}
        onRevoke={(key) => void run(() => revokeProjectTrust(key, null))}
      />

      <NewSkillDialog
        open={creating}
        taken={teraxNames}
        onClose={() => setCreating(false)}
        onCreate={async (name, description) => {
          const id = await createSkill(name, description);
          setCreating(false);
          await edit({ id, project: null });
        }}
      />

      <InstallSkillsDialog
        source={installing}
        onClose={closeInstall}
        onInstalled={({ installed, failed }) => {
          setInstalling(null);
          const done =
            installed.length === 0
              ? "Nothing was installed."
              : `Installed ${installed.join(", ")}.`;
          setNotice({
            tone: failed.length > 0 ? "error" : "info",
            text:
              failed.length > 0
                ? `${done} Not installed: ${failed.join("; ")}.`
                : done,
          });
        }}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.permanent
                ? `Delete ${pendingDelete.name} for good?`
                : `Move ${pendingDelete?.name ?? "this skill"} to the trash?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.permanent
                ? "The trash is not available for this folder. Deleting it cannot be undone."
                : "Its folder goes to the system trash, where you can restore it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pendingDelete?.permanent ? "Delete" : "Move to trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

function SkillGroupSection({
  group,
  snapshot,
  onToggle,
  onEdit,
  onDelete,
  onTrust,
  onRevoke,
}: {
  group: SkillGroup;
  snapshot: SkillsSnapshot;
  onToggle: (skill: Skill, on: boolean) => void;
  onEdit: (ref: SkillRef) => void;
  onDelete: (id: string, name: string) => void;
  onTrust: (status: ProjectTrustStatus, allow: boolean) => void;
  onRevoke: (key: string, kinds: TrustItemKind[]) => void;
}) {
  const deletable = group.id === "terax";
  const empty = group.skills.length === 0 && group.invalid.length === 0;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-col">
        <GroupLabel>
          {group.project ? `Project ${group.title}` : group.title}
        </GroupLabel>
        {group.path ? (
          <span
            className="truncate font-mono text-[10.5px] text-muted-foreground/80"
            title={group.path}
          >
            {group.path}
          </span>
        ) : null}
      </div>

      {group.trust.map((bar) => (
        <ProjectTrustBar
          key={bar.id}
          bar={bar}
          onTrust={(allow) => onTrust(bar.status, allow)}
          onRevoke={() => onRevoke(bar.status.project.key, bar.kinds)}
        />
      ))}

      {empty ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-4 text-center text-[11px] text-muted-foreground">
          {group.id === "terax"
            ? "No skills yet. Create one, or install skills from a Git repository or a zip file."
            : "No skills here."}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {group.skills.map((skill) => (
            <SkillRow
              key={skill.key}
              skill={skill}
              snapshot={snapshot}
              onToggle={(on) => onToggle(skill, on)}
              onEdit={() => onEdit(skillRef(skill))}
              onDelete={deletable ? () => onDelete(skill.id, skill.name) : null}
            />
          ))}
          {group.invalid.map((invalid) => (
            <InvalidRow
              key={`${invalid.id}:${invalid.project?.key ?? ""}`}
              invalid={invalid}
              onEdit={() => onEdit(skillRef(invalid))}
              onDelete={
                deletable ? () => onDelete(invalid.id, invalid.dirName) : null
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const TRUST_TEXT: Record<string, string> = {
  allowed: "In use",
  denied: "Not used",
  pending: "Not decided",
  changed: "Changed since your answer",
  unreviewable: "Cannot be used",
};

function ProjectTrustBar({
  bar,
  onTrust,
  onRevoke,
}: {
  bar: TrustBar;
  onTrust: (allow: boolean) => void;
  onRevoke: () => void;
}) {
  const { status } = bar;
  const decided = status.items.some(
    (item) => item.state === "allowed" || item.state === "denied",
  );
  const allAllowed = status.items.every((item) => item.state === "allowed");
  const reviewable = status.items.some((item) => item.hash !== null);
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2">
      <HugeiconsIcon
        icon={ShieldKeyIcon}
        size={14}
        strokeWidth={1.75}
        className="mt-0.5 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px]">
        {status.items.map((item) => (
          <span key={item.kind} className="flex items-center gap-1.5">
            <span title={item.path}>{item.label}</span>
            <span
              className={cn(
                "text-[10.5px]",
                item.state === "allowed"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : item.state === "unreviewable"
                    ? "text-destructive"
                    : "text-muted-foreground",
              )}
            >
              {TRUST_TEXT[item.state]}
              {item.problem ? `: ${item.problem}` : ""}
            </span>
          </span>
        ))}
        <span className="text-[10.5px] text-muted-foreground">{bar.note}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {decided ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={onRevoke}
          >
            Forget
          </Button>
        ) : null}
        {!allAllowed && reviewable ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => onTrust(true)}
          >
            {bar.accept}
          </Button>
        ) : null}
        {allAllowed ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => onTrust(false)}
          >
            Stop using
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "warn";
}) {
  return (
    <span
      className={cn(
        "rounded px-1 py-0.5 text-[9.5px] tracking-wide",
        tone === "warn"
          ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
          : "bg-muted/60 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function SkillRow({
  skill,
  snapshot,
  onToggle,
  onEdit,
  onDelete,
}: {
  skill: Skill;
  snapshot: SkillsSnapshot;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onDelete: (() => void) | null;
}) {
  const overriding = overridingSkill(skill, snapshot);
  const overrides = overriddenGlobal(skill, snapshot);
  const [showWarnings, setShowWarnings] = useState(false);
  return (
    <li
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2",
        (!skill.enabled || !skill.trusted) && "opacity-70",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[12px] font-medium">
            {skill.name}
          </span>
          {!skill.modelInvocable ? (
            <Badge>Only with /{skill.name}</Badge>
          ) : null}
          {!skill.userInvocable ? <Badge>AI only</Badge> : null}
          {overriding ? (
            <Badge tone="warn">
              Overridden by {sourceLabel(overriding.source)}
            </Badge>
          ) : null}
          {overrides ? (
            <Badge>Overrides your {sourceLabel(overrides.source)} skill</Badge>
          ) : null}
          {skill.warnings.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowWarnings((v) => !v)}
              className="rounded bg-amber-500/15 px-1 py-0.5 text-[9.5px] text-amber-700 hover:bg-amber-500/25 dark:text-amber-400"
            >
              {skill.warnings.length === 1
                ? "1 note"
                : `${skill.warnings.length} notes`}
            </button>
          ) : null}
        </span>
        <span className="line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground">
          {skill.description}
        </span>
        {showWarnings
          ? skill.warnings.map((w) => (
              <span
                key={w}
                className="text-[10.5px] text-amber-700 dark:text-amber-400"
              >
                {w}
              </span>
            ))
          : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={onEdit}
          title="Edit SKILL.md"
        >
          <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
        </Button>
        {onDelete ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            title="Delete"
          >
            <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
          </Button>
        ) : null}
        <Switch
          className="ml-1"
          checked={skill.enabled}
          disabled={!skill.trusted}
          onCheckedChange={onToggle}
          aria-label={`Use ${skill.name}`}
        />
      </div>
    </li>
  );
}

function InvalidRow({
  invalid,
  onEdit,
  onDelete,
}: {
  invalid: InvalidSkill;
  onEdit: () => void;
  onDelete: (() => void) | null;
}) {
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[12px]">{invalid.dirName}</span>
          <Badge tone="warn">Not loaded</Badge>
        </span>
        {invalid.errors.map((e) => (
          <span key={e} className="text-[10.5px] text-destructive">
            {e}
          </span>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={onEdit}
          title="Edit SKILL.md"
        >
          <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
        </Button>
        {onDelete ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            title="Delete"
          >
            <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function TrustedProjects({
  recorded,
  onRevoke,
}: {
  recorded: RecordedTrust[];
  onRevoke: (key: string) => void;
}) {
  if (recorded.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col">
        <GroupLabel>Project decisions</GroupLabel>
        <span className="text-[10.5px] text-muted-foreground">
          Projects whose instructions (TERAX.md), skills or MCP servers you
          allowed or declined. Forget one to be asked again next time you open
          it.
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {recorded.map((project) => (
          <li
            key={project.key}
            className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className="truncate font-mono text-[11.5px]"
                title={project.root}
              >
                {project.root}
              </span>
              <span className="text-[10.5px] text-muted-foreground">
                {project.items
                  .map(
                    (item) =>
                      `${item.label}: ${item.allowed ? "allowed" : "declined"}`,
                  )
                  .join(" · ")}
                {project.exists ? "" : " · folder not found"}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => onRevoke(project.key)}
            >
              Forget
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
