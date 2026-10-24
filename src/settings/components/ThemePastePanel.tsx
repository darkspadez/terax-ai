import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";

type Props = {
  /** Resolves true once the text was imported, which closes the panel. */
  onImport: (text: string) => Promise<boolean>;
  onClose: () => void;
};

export function ThemePastePanel({ onImport, onClose }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const empty = text.trim() === "";

  const submit = async () => {
    if (empty || busy) return;
    setBusy(true);
    try {
      if (await onImport(text)) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-2.5">
      <Textarea
        autoFocus
        value={text}
        spellCheck={false}
        aria-label="Colour scheme"
        placeholder="Paste a Ghostty theme, an Alacritty or Windows Terminal scheme, or the contents of an .itermcolors file."
        className="field-sizing-fixed h-32 rounded-md px-2.5 py-2 font-mono text-[11px] md:text-[11px]"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={empty || busy}
          onClick={() => void submit()}
        >
          Import
        </Button>
      </div>
    </div>
  );
}
