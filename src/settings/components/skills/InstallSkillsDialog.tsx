import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  cancelInstall,
  commitInstall,
  installFromGit,
  installFromZip,
} from "@/modules/skills/api";
import type {
  InstallCandidate,
  InstallPreview,
  InstallResult,
} from "@/modules/skills/types";
import { useCallback, useEffect, useRef, useState } from "react";

export type InstallSource = "git" | "zip";

type Props = {
  source: InstallSource | null;
  onClose: () => void;
  onInstalled: (result: InstallResult) => void;
};

const installable = (c: InstallCandidate) => c.errors.length === 0;

/** Valid skills not installed yet start checked; replacing one takes a click. */
function defaultSelection(preview: InstallPreview): Set<string> {
  return new Set(
    preview.candidates
      .filter((c) => installable(c) && !c.exists)
      .map((c) => c.name),
  );
}

export function InstallSkillsDialog({ source, onClose, onInstalled }: Props) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<InstallPreview | null>(null);
  previewRef.current = preview;

  const accept = useCallback((next: InstallPreview) => {
    setPreview(next);
    setSelected(defaultSelection(next));
  }, []);

  const close = () => {
    const pending = previewRef.current;
    if (pending) void cancelInstall(pending.token);
    setPreview(null);
    setUrl("");
    setError(null);
    setBusy(false);
    onClose();
  };

  // A zip install starts with the system picker; cancelling it closes the dialog.
  useEffect(() => {
    if (source !== "zip") return;
    let alive = true;
    setBusy(true);
    installFromZip()
      .then((next) => {
        if (!alive) {
          if (next) void cancelInstall(next.token);
          return;
        }
        if (next) accept(next);
        else onClose();
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [source, onClose, accept]);

  const fetchRepository = async () => {
    setBusy(true);
    setError(null);
    try {
      accept(await installFromGit(url));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const names = [...selected];
    const replace = preview.candidates
      .filter((c) => c.exists && selected.has(c.name))
      .map((c) => c.name);
    try {
      const result = await commitInstall(preview.token, names, replace);
      previewRef.current = null;
      setPreview(null);
      setUrl("");
      onInstalled(result);
    } catch (e) {
      previewRef.current = null;
      setPreview(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  return (
    <Dialog open={source !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {source === "zip"
              ? "Install skills from a zip file"
              : "Install skills from Git"}
          </DialogTitle>
          <DialogDescription>
            Skills are copied into Terax's skills folder. Their scripts run
            through the AI's shell tool, so install skills only from sources you
            trust.
          </DialogDescription>
        </DialogHeader>

        {source === "git" && !preview ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void fetchRepository();
            }}
          >
            <Input
              autoFocus
              value={url}
              spellCheck={false}
              placeholder="https://github.com/owner/repo (or a /tree/branch/folder address)"
              className="h-8 flex-1 font-mono text-[12px]"
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              disabled={busy || url.trim() === ""}
            >
              {busy ? <Spinner className="size-3" /> : null}
              Find skills
            </Button>
          </form>
        ) : null}

        {busy && !preview && source === "zip" ? (
          <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <Spinner className="size-3" /> Reading the zip file…
          </div>
        ) : null}

        {preview ? (
          <div className="flex flex-col gap-2">
            <span
              className="truncate font-mono text-[10.5px] text-muted-foreground"
              title={preview.source}
            >
              {preview.source}
            </span>
            <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
              {preview.candidates.map((c) => (
                <CandidateRow
                  key={`${c.location}:${c.name}`}
                  candidate={c}
                  checked={selected.has(c.name)}
                  onCheckedChange={(on) => toggle(c.name, on)}
                />
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
            Cancel
          </Button>
          {preview ? (
            <Button
              size="sm"
              disabled={busy || selected.size === 0}
              onClick={() => void install()}
            >
              {busy ? <Spinner className="size-3" /> : null}
              Install {selected.size > 0 ? selected.size : ""}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({
  candidate,
  checked,
  onCheckedChange,
}: {
  candidate: InstallCandidate;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
}) {
  const ok = installable(candidate);
  return (
    <li className="flex items-start gap-2 rounded-lg border border-border/60 bg-card/60 px-2.5 py-2">
      <Checkbox
        className="mt-0.5"
        disabled={!ok}
        checked={ok && checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        aria-label={`Install ${candidate.name}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[12px]">{candidate.name}</span>
          {candidate.location !== "." ? (
            <span className="truncate text-[10px] text-muted-foreground">
              {candidate.location}
            </span>
          ) : null}
        </span>
        {candidate.description ? (
          <span className="line-clamp-2 text-[10.5px] text-muted-foreground">
            {candidate.description}
          </span>
        ) : null}
        {candidate.exists && ok ? (
          <span className="text-[10.5px] text-amber-600 dark:text-amber-400">
            Already installed: checking it replaces the installed skill (the old
            one goes to the trash).
          </span>
        ) : null}
        {candidate.errors.map((e) => (
          <span key={e} className="text-[10.5px] text-destructive">
            {e}
          </span>
        ))}
        {candidate.warnings.map((w) => (
          <span key={w} className="text-[10.5px] text-muted-foreground">
            {w}
          </span>
        ))}
      </div>
    </li>
  );
}
