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
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_SKILL_DESCRIPTION,
  normalizeSkillName,
  skillNameError,
} from "@/modules/skills/names";
import { useState } from "react";

type Props = {
  open: boolean;
  /** Names already in Terax's folder. */
  taken: ReadonlySet<string>;
  onClose: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
};

export function NewSkillDialog({ open, taken, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameError =
    skillNameError(name) ??
    (taken.has(name) ? "A skill with this name exists" : null);
  const trimmed = description.trim();
  const descriptionError =
    trimmed.length === 0
      ? "Describe what it does and when to use it"
      : trimmed.length > MAX_SKILL_DESCRIPTION
        ? `At most ${MAX_SKILL_DESCRIPTION} characters`
        : null;

  const reset = () => {
    setName("");
    setDescription("");
    setTouched(false);
    setError(null);
  };

  const submit = async () => {
    setTouched(true);
    if (nameError || descriptionError) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name, trimmed);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
          <DialogDescription>
            Creates a folder with a SKILL.md in Terax's skills folder and opens
            it in the editor to write the instructions.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <label
              htmlFor="new-skill-name"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Name
            </label>
            <Input
              id="new-skill-name"
              autoFocus
              value={name}
              placeholder="release-notes"
              spellCheck={false}
              className="h-8 font-mono text-[12px]"
              onChange={(e) => setName(normalizeSkillName(e.target.value))}
              aria-invalid={touched && nameError !== null}
            />
            <span className="text-[10.5px] text-muted-foreground">
              {touched && nameError
                ? nameError
                : `You call it with /${name || "name"} in the AI input.`}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="new-skill-description"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Description
            </label>
            <Textarea
              id="new-skill-description"
              value={description}
              rows={3}
              placeholder="Writes release notes from the commits since the last tag. Use when the user asks for release notes or a changelog."
              className="text-[12px]"
              onChange={(e) => setDescription(e.target.value)}
              aria-invalid={touched && descriptionError !== null}
            />
            <span className="text-[10.5px] text-muted-foreground">
              {touched && descriptionError
                ? descriptionError
                : "The AI reads this to decide when to use the skill."}
            </span>
          </div>
          {error ? (
            <p className="text-[11px] text-destructive">{error}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              Create and edit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
