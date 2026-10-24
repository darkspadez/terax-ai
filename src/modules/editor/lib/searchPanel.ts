import { isImeKeyEvent } from "@/lib/ime";
import { formatMatchCount } from "@/lib/matchCount";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import {
  type EditorView,
  type Panel,
  runScopeHandlers,
  type ViewUpdate,
} from "@codemirror/view";
import { searchCounter } from "./searchCount";

type Attributes = Record<string, string | boolean>;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes,
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === true) node.setAttribute(name, "");
    else if (value !== false) node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

/**
 * CodeMirror's find and replace panel, field for field, with the match count
 * ("3 of 12") after the search field. The count comes from `searchCounter`,
 * which counts only while this panel (or another reader) listens.
 */
class CountedSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top: boolean;
  private query: SearchQuery;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly caseField: HTMLInputElement;
  private readonly reField: HTMLInputElement;
  private readonly wordField: HTMLInputElement;
  private readonly countField: HTMLElement;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly view: EditorView,
    top: boolean,
  ) {
    this.top = top;
    const phrase = (text: string) => view.state.phrase(text);
    const query = getSearchQuery(view.state);
    this.query = query;
    const commit = () => this.commit();
    const field = (name: string, value: string, label: string) => {
      const input = element("input", {
        value,
        placeholder: phrase(label),
        "aria-label": phrase(label),
        class: "cm-textfield",
        name,
        form: "",
      });
      input.value = value;
      input.addEventListener("change", commit);
      input.addEventListener("keyup", commit);
      return input;
    };
    const checkbox = (name: string, checked: boolean) => {
      const input = element("input", { type: "checkbox", name, form: "" });
      input.checked = checked;
      input.addEventListener("change", commit);
      return input;
    };
    const button = (name: string, label: string, run: () => void) => {
      const node = element(
        "button",
        { class: "cm-button", name, type: "button" },
        [phrase(label)],
      );
      node.addEventListener("click", run);
      return node;
    };

    this.searchField = field("search", query.search, "Find");
    this.searchField.setAttribute("main-field", "true");
    this.replaceField = field("replace", query.replace, "Replace");
    this.caseField = checkbox("case", query.caseSensitive);
    this.reField = checkbox("re", query.regexp);
    this.wordField = checkbox("word", query.wholeWord);
    this.countField = element("span", { class: "cm-search-count" });

    const close = element(
      "button",
      { name: "close", "aria-label": phrase("close"), type: "button" },
      ["×"],
    );
    close.addEventListener("click", () => closeSearchPanel(view));

    this.dom = element("div", { class: "cm-search" }, [
      this.searchField,
      this.countField,
      button("next", "next", () => findNext(view)),
      button("prev", "previous", () => findPrevious(view)),
      button("select", "all", () => selectMatches(view)),
      element("label", {}, [this.caseField, phrase("match case")]),
      element("label", {}, [this.reField, phrase("regexp")]),
      element("label", {}, [this.wordField, phrase("by word")]),
      ...(view.state.readOnly
        ? []
        : [
            element("br", {}),
            this.replaceField,
            button("replace", "replace", () => replaceNext(view)),
            button("replaceAll", "replace all", () => replaceAll(view)),
          ]),
      close,
    ]);
    this.dom.addEventListener("keydown", (event) => this.keydown(event));
  }

  mount(): void {
    this.searchField.select();
    const hub = this.view.plugin(searchCounter)?.hub;
    if (!hub) return;
    const show = () => {
      this.countField.textContent = formatMatchCount(hub.get());
    };
    this.unsubscribe = hub.subscribe(show);
    show();
  }

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.setQuery(effect.value);
        }
      }
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.reField.checked,
      wholeWord: this.wordField.checked,
      replace: this.replaceField.value,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private keydown(event: KeyboardEvent): void {
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
      return;
    }
    // The Enter that confirms an input method's candidate is the IME's.
    if (event.key !== "Enter" || isImeKeyEvent(event)) return;
    if (event.target === this.searchField) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    } else if (event.target === this.replaceField) {
      event.preventDefault();
      replaceNext(this.view);
    }
  }

  private setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseField.checked = query.caseSensitive;
    this.reField.checked = query.regexp;
    this.wordField.checked = query.wholeWord;
  }
}

/** Search with CodeMirror's keymap and state, the counted panel, and the counter. */
export function countedSearch(config: { top: boolean }): Extension {
  return [
    search({
      top: config.top,
      createPanel: (view) => new CountedSearchPanel(view, config.top),
    }),
    searchCounter,
  ];
}
