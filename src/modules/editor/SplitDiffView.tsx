import { defaultKeymap } from "@codemirror/commands";
import { foldGutter } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { SPLIT_DIFF_THEME } from "./lib/diffTheme";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  languageCompartment,
} from "./lib/extensions";
import { syncViewText } from "./lib/viewSync";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";

type Props = {
  original: string;
  modified: string;
  /** Resolved before mount, like the inline view's. */
  langExt: Extension | null;
};

const SHARED_EXT = buildSharedExtensions();
const themeCompartment = new Compartment();

/**
 * Original and modified side by side, aligned line by line. MergeView owns
 * two EditorViews, so it cannot render through <CodeMirror>: it is built
 * once and updated in place, which keeps scroll position and expanded
 * regions across a refetch or a theme switch.
 */
export function SplitDiffView({ original, modified, langExt }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeView | null>(null);
  const themeExt = useEditorThemeExt();
  const initial = useRef({ original, modified, langExt, themeExt });

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const start = initial.current;
    const side = (doc: string) => ({
      doc,
      extensions: [
        ...SHARED_EXT,
        DEFAULT_INDENT,
        lineNumbers(),
        foldGutter(),
        highlightSpecialChars(),
        drawSelection(),
        keymap.of([...defaultKeymap, ...searchKeymap]),
        languageCompartment.of(start.langExt ?? []),
        themeCompartment.of(start.themeExt),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        SPLIT_DIFF_THEME,
      ],
    });
    const view = new MergeView({
      a: side(start.original),
      b: side(start.modified),
      parent,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    syncViewText(view.a, original);
    syncViewText(view.b, modified);
  }, [original, modified]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    for (const side of [view.a, view.b]) {
      side.dispatch({
        effects: [
          themeCompartment.reconfigure(themeExt),
          languageCompartment.reconfigure(langExt ?? []),
        ],
      });
    }
  }, [themeExt, langExt]);

  return (
    <div
      ref={containerRef}
      className="oarlock-code-editor h-full [&>.cm-mergeView]:h-full [&>.cm-mergeView]:overflow-auto"
    />
  );
}
