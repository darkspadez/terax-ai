import {
  type EditorState,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  showTooltip,
  type Tooltip,
  type TooltipView,
} from "@codemirror/view";
import { Clock01Icon } from "@hugeicons/core-free-icons";
import { hugeIcon } from "./completionIcons";

type Fetcher = (query: string, limit: number) => Promise<string[]>;

export type HState = { open: boolean; items: string[]; index: number };

const CLOSED: HState = { open: false, items: [], index: 0 };
const LIMIT = 200;
const REFILTER_MS = 60;

const setHistory = StateEffect.define<HState>();

const historyField = StateField.define<HState>({
  create: () => CLOSED,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHistory)) return e.value;
    return value;
  },
  provide: (f) => showTooltip.from(f, (s) => (s.open ? TOOLTIP : null)),
});

export function historyOpen(state: EditorState): boolean {
  return state.field(historyField, false)?.open ?? false;
}

function dispatch(view: EditorView, next: HState) {
  view.dispatch({ effects: setHistory.of(next) });
}

function close(view: EditorView) {
  if (view.state.field(historyField, false)?.open) dispatch(view, CLOSED);
}

function acceptIndex(view: EditorView, i: number) {
  const h = view.state.field(historyField, false);
  const cmd = h?.items[i];
  if (cmd == null) {
    close(view);
    return;
  }
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: cmd },
    selection: { anchor: cmd.length },
    effects: setHistory.of(CLOSED),
  });
  view.focus();
}

const TOOLTIP: Tooltip = {
  pos: 0,
  above: true,
  strictSide: true,
  arrow: false,
  create: historyTooltipView,
};

/**
 * What the rows need after a state change: rebuilt only when the items
 * change, else the selection moves between two rows. Rebuilding on every
 * arrow press put a fresh row under a resting pointer, and its hover undid
 * the press.
 */
export function historyRowsUpdate(
  prev: HState | null,
  next: HState,
): { rebuild: boolean; deselect: number | null; select: number } {
  if (!prev || prev.items !== next.items) {
    return { rebuild: true, deselect: null, select: next.index };
  }
  return {
    rebuild: false,
    deselect: prev.index === next.index ? null : prev.index,
    select: next.index,
  };
}

/**
 * Tells real pointer movement from the events a browser sends when rows move
 * under a resting pointer (scrolled into view, re-laid out): only the former
 * selects a row. The first event only records where the pointer is.
 */
export class PointerMotion {
  private at: string | null = null;

  moved(event: { screenX: number; screenY: number }): boolean {
    const at = `${event.screenX},${event.screenY}`;
    const moved = this.at !== null && this.at !== at;
    this.at = at;
    return moved;
  }
}

function historyTooltipView(view: EditorView): TooltipView {
  const dom = document.createElement("div");
  dom.className = "cm-history-popover";
  const list = document.createElement("div");
  list.className = "cm-history-list";
  const footer = document.createElement("div");
  footer.className = "cm-history-footer";
  footer.textContent = "↑↓ navigate · ↵ run · esc";
  dom.append(list, footer);

  const pointer = new PointerMotion();
  let shown: HState | null = null;

  const row = (i: number) => list.children[i] as HTMLElement | undefined;

  const buildRows = (items: string[]) => {
    list.replaceChildren();
    items.forEach((cmd, i) => {
      const item = document.createElement("div");
      item.className = "cm-history-item";
      const icon = hugeIcon(Clock01Icon, 12);
      icon.classList.add("cm-history-icon");
      const text = document.createElement("span");
      text.className = "cm-history-text";
      text.textContent = cmd;
      item.append(icon, text);
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        acceptIndex(view, i);
      });
      item.addEventListener("mousemove", (e) => {
        if (!pointer.moved(e)) return;
        const cur = view.state.field(historyField, false);
        if (cur?.open && cur.index !== i) {
          dispatch(view, { ...cur, index: i });
        }
      });
      list.appendChild(item);
    });
  };

  const render = () => {
    const h = view.state.field(historyField);
    const update = historyRowsUpdate(shown, h);
    shown = h;
    if (update.rebuild) buildRows(h.items);
    if (update.deselect !== null)
      row(update.deselect)?.removeAttribute("aria-selected");
    const active = row(update.select);
    active?.setAttribute("aria-selected", "true");
    active?.scrollIntoView({ block: "nearest" });
  };

  render();
  return {
    dom,
    mount: render,
    update(u) {
      if (u.state.field(historyField) !== u.startState.field(historyField)) {
        render();
      }
    },
  };
}

export function historyPopover(fetch: Fetcher) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = (view: EditorView) => {
    const query = view.state.doc.toString();
    void fetch(query, LIMIT).then((items) => {
      if (items.length) dispatch(view, { open: true, items, index: 0 });
    });
  };

  const refilter = (view: EditorView) => {
    if (timer) clearTimeout(timer);
    const query = view.state.doc.toString();
    timer = setTimeout(() => {
      void fetch(query, LIMIT).then((items) => {
        if (view.state.field(historyField, false)?.open) {
          dispatch(view, { open: true, items, index: 0 });
        }
      });
    }, REFILTER_MS);
  };

  const upOrOpen = (view: EditorView): boolean => {
    const h = view.state.field(historyField, false);
    if (h?.open) {
      if (h.index > 0) dispatch(view, { ...h, index: h.index - 1 });
      return true;
    }
    const head = view.state.selection.main.head;
    if (view.state.doc.lineAt(head).number !== 1) return false;
    open(view);
    return true;
  };

  const downOrClose = (view: EditorView): boolean => {
    const h = view.state.field(historyField, false);
    if (!h?.open) return false;
    if (h.index >= h.items.length - 1) close(view);
    else dispatch(view, { ...h, index: h.index + 1 });
    return true;
  };

  const accept = (view: EditorView): boolean => {
    const h = view.state.field(historyField, false);
    if (!h?.open) return false;
    acceptIndex(view, h.index);
    return true;
  };

  const dismiss = (view: EditorView): boolean => {
    if (!view.state.field(historyField, false)?.open) return false;
    close(view);
    return true;
  };

  return [
    historyField,
    Prec.highest(
      keymap.of([
        { key: "ArrowUp", run: upOrOpen },
        { key: "ArrowDown", run: downOrClose },
        { key: "Enter", run: accept },
        { key: "Escape", run: dismiss },
      ]),
    ),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      if (u.state.field(historyField, false)?.open) refilter(u.view);
    }),
  ];
}
