import { Chunk } from "@codemirror/merge";
import {
  type EditorState,
  type Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";

export type LineChange = {
  line: number;
  kind: "added" | "modified" | "removed-above" | "removed-below";
};

// Bounded so a huge rewrite falls back to coarse chunks instead of stalling
// typing; the gutter is a hint, not the diff view.
const DIFF_CONFIG = { scanLimit: 500, timeout: 50 };

/**
 * 1-based lines of `doc` that differ from the committed text, from merge
 * chunks: lines only in `doc` are added, lines replacing others modified,
 * and a removal marks the line after it (or the last line, at the end).
 */
export function lineChanges(chunks: readonly Chunk[], doc: Text): LineChange[] {
  const out: LineChange[] = [];
  for (const chunk of chunks) {
    if (chunk.fromB === chunk.toB) {
      // Past the end (a file without a final newline) or at the end of a
      // non-empty last line, the removal sits below the last line.
      const pos = Math.min(chunk.fromB, doc.length);
      const line = doc.lineAt(pos);
      const above = chunk.fromB <= doc.length && pos === line.from;
      out.push({
        line: line.number,
        kind: above ? "removed-above" : "removed-below",
      });
      continue;
    }
    const kind = chunk.fromA === chunk.toA ? "added" : "modified";
    const first = doc.lineAt(chunk.fromB).number;
    const last = doc.lineAt(Math.min(chunk.endB, doc.length)).number;
    for (let line = first; line <= last; line++) out.push({ line, kind });
  }
  return out;
}

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: LineChange["kind"]) {
    super();
    this.elementClass = `cm-gitChange cm-gitChange-${kind}`;
  }
}

const MARKERS = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  "removed-above": new ChangeMarker("removed-above"),
  "removed-below": new ChangeMarker("removed-below"),
};

type GitBase = {
  base: Text;
  chunks: readonly Chunk[];
  markers: RangeSet<GutterMarker>;
};

function markersFor(
  chunks: readonly Chunk[],
  doc: Text,
): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  let previous = 0;
  for (const change of lineChanges(chunks, doc)) {
    // One marker per line; a removal next to an edited line yields to it.
    if (change.line === previous) continue;
    previous = change.line;
    const from = doc.line(change.line).from;
    builder.add(from, from, MARKERS[change.kind]);
  }
  return builder.finish();
}

/** The committed text (LF), or null outside a repository or for new files. */
export const setGitBase = StateEffect.define<string | null>();

const gitBaseField = StateField.define<GitBase | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setGitBase)) continue;
      if (effect.value === null) return null;
      if (value && value.base.toString() === effect.value) continue;
      const base = Text.of(effect.value.split("\n"));
      const chunks = Chunk.build(base, tr.state.doc, DIFF_CONFIG);
      return { base, chunks, markers: markersFor(chunks, tr.state.doc) };
    }
    if (!value || !tr.docChanged) return value;
    const chunks = Chunk.updateB(
      value.chunks,
      value.base,
      tr.state.doc,
      tr.changes,
      DIFF_CONFIG,
    );
    return { ...value, chunks, markers: markersFor(chunks, tr.state.doc) };
  },
});

/** 1-based lines that carry a change marker. */
export function markedLines(state: EditorState): number[] {
  const lines: number[] = [];
  const markers = state.field(gitBaseField, false)?.markers;
  for (let it = markers?.iter(); it?.value; it.next()) {
    lines.push(state.doc.lineAt(it.from).number);
  }
  return lines;
}

/** Lines changed since the last commit, updated as the buffer is edited. */
export const gitChangeGutter: Extension = [
  gitBaseField,
  gutter({
    class: "cm-gitChangeGutter",
    markers: (view) =>
      view.state.field(gitBaseField)?.markers ?? RangeSet.empty,
  }),
  EditorView.baseTheme({
    ".cm-gitChangeGutter": { width: "3px", marginRight: "2px" },
    ".cm-gitChangeGutter .cm-gutterElement": { padding: "0" },
    ".cm-gitChange-added": { backgroundColor: "#73c991" },
    ".cm-gitChange-modified": { backgroundColor: "#5aa9e6" },
    ".cm-gitChange-removed-above": { boxShadow: "inset 0 2px 0 0 #e06c75" },
    ".cm-gitChange-removed-below": { boxShadow: "inset 0 -2px 0 0 #e06c75" },
  }),
];
