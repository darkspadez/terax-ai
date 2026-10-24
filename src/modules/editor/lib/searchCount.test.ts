import {
  getSearchQuery,
  SearchQuery,
  search,
  setSearchQuery,
} from "@codemirror/search";
import {
  EditorSelection,
  EditorState,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  MatchScan,
  SearchCountHub,
  SearchCounter,
  searchCountHub,
  selectedMatch,
} from "./searchCount";

function fullScan(state: EditorState, query: SearchQuery) {
  const from: number[] = [];
  const to: number[] = [];
  const cursor = query.getCursor(state);
  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    from.push(match.value.from);
    to.push(match.value.to);
  }
  return { from, to };
}

function chunkedScan(
  state: EditorState,
  query: SearchQuery,
  chunk: number,
  cap = 10_000,
) {
  const scan = new MatchScan(state, query, cap, chunk);
  // One chunk per slice, to cross every boundary.
  while (!scan.step(() => true));
  return scan;
}

const DOCS = [
  "",
  "ab ab\nab\n\nxaba ABab aab",
  "aaaa aaa\naa\na\n",
  "line one\nline two\n  line three\nlast line",
  "café café ﬁle file FILE\nstraße STRASSE",
  "x\n".repeat(40),
];

const QUERIES: SearchQuery[] = [
  new SearchQuery({ search: "ab" }),
  new SearchQuery({ search: "ab", caseSensitive: true }),
  new SearchQuery({ search: "aa" }),
  new SearchQuery({ search: "ab", wholeWord: true }),
  new SearchQuery({ search: "b\\nab" }),
  new SearchQuery({ search: "line\\n" }),
  new SearchQuery({ search: "\\n", literal: true }),
  new SearchQuery({ search: "fi" }),
  new SearchQuery({ search: "é" }),
  new SearchQuery({ search: "a+", regexp: true }),
  new SearchQuery({ search: "^l\\w*", regexp: true }),
  new SearchQuery({ search: "$", regexp: true }),
  new SearchQuery({ search: "b?", regexp: true }),
  new SearchQuery({ search: "e\\s+l", regexp: true }),
  new SearchQuery({ search: "x\\nx", regexp: true }),
];

describe("MatchScan", () => {
  it("finds exactly what one pass over the whole document finds, at any chunk size", () => {
    for (const doc of DOCS) {
      const state = EditorState.create({ doc });
      for (const query of QUERIES) {
        const expected = fullScan(state, query);
        for (const chunk of [1, 2, 3, 5, 8, 13, 64]) {
          const scan = chunkedScan(state, query, chunk);
          expect(
            { from: scan.from, to: scan.to },
            `${JSON.stringify(doc)} ${query.search} chunk ${chunk}`,
          ).toEqual(expected);
          expect(scan.capped).toBe(false);
        }
      }
    }
  });

  it("finds what one pass finds in random text with every kind of query", () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const alphabet = ["a", "b", "A", " ", "\n", "-", "\u00e9", "e\u0301"];
    const queries = [
      new SearchQuery({ search: "ab" }),
      new SearchQuery({ search: "aa", caseSensitive: true }),
      new SearchQuery({ search: "a", wholeWord: true }),
      new SearchQuery({ search: "b\\na" }),
      new SearchQuery({ search: "\u00e9" }),
      new SearchQuery({ search: "a+b?", regexp: true }),
      new SearchQuery({ search: "\\ba\\b", regexp: true }),
      new SearchQuery({ search: "a", regexp: true, wholeWord: true }),
      new SearchQuery({ search: "b\\s+a", regexp: true }),
    ];
    for (let round = 0; round < 40; round++) {
      let doc = "";
      const length = random(120);
      for (let i = 0; i < length; i++) doc += alphabet[random(alphabet.length)];
      const state = EditorState.create({ doc });
      for (const query of queries) {
        const expected = fullScan(state, query);
        const chunk = 1 + random(20);
        const scan = chunkedScan(state, query, chunk);
        expect(
          { from: scan.from, to: scan.to },
          `${JSON.stringify(doc)} ${query.search} chunk ${chunk}`,
        ).toEqual(expected);
      }
    }
  });

  it("stops at the cap", () => {
    const state = EditorState.create({ doc: "a ".repeat(50) });
    const scan = chunkedScan(state, new SearchQuery({ search: "a" }), 7, 10);
    expect(scan.from).toHaveLength(10);
    expect(scan.capped).toBe(true);
    expect(scan.done).toBe(true);
  });

  it("works in slices, picking up where a slice ended", () => {
    const state = EditorState.create({ doc: "match\n".repeat(200) });
    const query = new SearchQuery({ search: "match" });
    const scan = new MatchScan(state, query, 10_000, 60);
    let checks = 0;
    expect(scan.step(() => ++checks >= 3)).toBe(false);
    expect(scan.done).toBe(false);
    const partial = scan.from.length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(200);
    expect(scan.step(() => false)).toBe(true);
    expect(scan.from).toEqual(fullScan(state, query).from);
  });

  it("does not count a multi-line regular expression in a huge document", () => {
    const state = EditorState.create({ doc: "a\n".repeat(2_200_000) });
    const multiline = new MatchScan(
      state,
      new SearchQuery({ search: "a\\sa", regexp: true }),
    );
    expect(multiline.unsupported).toBe(true);
    expect(multiline.step(() => false)).toBe(true);
    expect(multiline.from).toEqual([]);
    const single = new MatchScan(
      state,
      new SearchQuery({ search: "^a$", regexp: true }),
      5,
    );
    expect(single.unsupported).toBe(false);
    single.step(() => false);
    expect(single.capped).toBe(true);
  });
});

describe("selectedMatch", () => {
  const from = [0, 4, 10, 20];
  const to = [2, 6, 12, 22];

  it("is the 1-based index of the match the selection covers exactly", () => {
    expect(selectedMatch(from, to, 0, 2)).toBe(1);
    expect(selectedMatch(from, to, 10, 12)).toBe(3);
    expect(selectedMatch(from, to, 20, 22)).toBe(4);
  });

  it("is 0 for a selection that is not a match", () => {
    expect(selectedMatch(from, to, 4, 5)).toBe(0);
    expect(selectedMatch(from, to, 7, 7)).toBe(0);
    expect(selectedMatch([], [], 0, 0)).toBe(0);
  });
});

describe("SearchCountHub", () => {
  it("tells its watchers when the first reader arrives and the last one leaves", () => {
    const hub = new SearchCountHub();
    const watcher = vi.fn();
    hub.watchDemand(watcher);
    const first = hub.subscribe(() => {});
    const second = hub.subscribe(() => {});
    expect(watcher).toHaveBeenCalledTimes(1);
    expect(hub.wanted).toBe(true);
    first();
    first();
    expect(watcher).toHaveBeenCalledTimes(1);
    second();
    expect(watcher).toHaveBeenCalledTimes(2);
    expect(hub.wanted).toBe(false);
  });

  it("tells readers only about a different count", () => {
    const hub = new SearchCountHub();
    const reader = vi.fn();
    hub.subscribe(reader);
    const count = { current: 1, total: 2, capped: false, pending: false };
    hub.publish(count);
    hub.publish({ ...count });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(hub.get()).toEqual(count);
    hub.publish(null);
    expect(reader).toHaveBeenCalledTimes(2);
  });
});

describe("SearchCounter", () => {
  function setup(doc: string) {
    const hub = new SearchCountHub();
    const view = {
      state: EditorState.create({
        doc,
        extensions: [search(), searchCountHub.of(hub)],
      }),
    };
    const counter = new SearchCounter(view as unknown as EditorView);
    const apply = (spec: TransactionSpec) => {
      const tr = view.state.update(spec);
      view.state = tr.state;
      counter.update({
        state: tr.state,
        docChanged: tr.docChanged,
        selectionSet: !!spec.selection,
      } as unknown as ViewUpdate);
    };
    const find = (text: string) =>
      apply({ effects: setSearchQuery.of(new SearchQuery({ search: text })) });
    return { hub, view, counter, apply, find };
  }

  it("counts nothing until something reads the count", () => {
    const t = setup("one two one");
    t.find("one");
    expect(t.hub.get()).toBeNull();
    t.hub.subscribe(() => {});
    expect(t.hub.get()).toEqual({
      current: 0,
      total: 2,
      capped: false,
      pending: false,
    });
  });

  it("follows the query, the selection and edits", () => {
    const t = setup("one two one");
    t.hub.subscribe(() => {});
    t.find("one");
    expect(t.hub.get()?.total).toBe(2);
    t.apply({ selection: EditorSelection.single(8, 11) });
    expect(t.hub.get()?.current).toBe(2);
    t.apply({ changes: { from: 0, insert: "one " } });
    expect(t.hub.get()?.total).toBe(3);
    t.find("two");
    expect(t.hub.get()).toMatchObject({ current: 0, total: 1 });
    t.find("");
    expect(t.hub.get()).toBeNull();
    expect(getSearchQuery(t.view.state).search).toBe("");
  });

  it("drops the count when its view goes", () => {
    const t = setup("abc");
    t.hub.subscribe(() => {});
    t.find("b");
    expect(t.hub.get()?.total).toBe(1);
    t.counter.destroy();
    expect(t.hub.get()).toBeNull();
  });
});
