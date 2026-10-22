import {
  EditorSelection,
  EditorState,
  type Transaction,
} from "@codemirror/state";
import { ExternalChange } from "@uiw/react-codemirror";
import { describe, expect, it } from "vitest";
import { applyFormattedContent, minimalChange, syncViewText } from "./viewSync";

function view(doc: string, cursor = 0) {
  const transactions: Transaction[] = [];
  const v = {
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
    }),
    dispatch: (spec: Parameters<EditorState["update"]>[0]) => {
      const tr = v.state.update(spec);
      transactions.push(tr);
      v.state = tr.state;
    },
    transactions,
  };
  return v;
}

describe("minimalChange", () => {
  it("is null for equal texts", () => {
    expect(minimalChange("abc", "abc")).toBeNull();
  });

  it("replaces only the differing middle", () => {
    expect(minimalChange("let a = 1;\n", "let ab = 12;\n")).toEqual({
      from: 5,
      to: 9,
      insert: "b = 12",
    });
  });

  it("handles pure insertions and deletions", () => {
    expect(minimalChange("ac", "abc")).toEqual({ from: 1, to: 1, insert: "b" });
    expect(minimalChange("abc", "ac")).toEqual({ from: 1, to: 2, insert: "" });
    expect(minimalChange("", "x")).toEqual({ from: 0, to: 0, insert: "x" });
  });
});

describe("syncViewText", () => {
  it("shows the adopted text as an external change", () => {
    const v = view("one\nedited\nthree\n", 2);
    syncViewText(v, "one\ntwo\nthree\n");
    expect(v.state.doc.toString()).toBe("one\ntwo\nthree\n");
    expect(v.transactions).toHaveLength(1);
    expect(v.transactions[0].annotation(ExternalChange)).toBe(true);
    expect(v.state.selection.main.head).toBe(2);
  });

  it("dispatches nothing when the view already shows the text", () => {
    const v = view("same\n");
    syncViewText(v, "same\n");
    expect(v.transactions).toHaveLength(0);
  });
});

describe("applyFormattedContent", () => {
  it("dispatches a user-visible edit", () => {
    const v = view("a  =1\n");
    applyFormattedContent(v, "a = 1\n");
    expect(v.state.doc.toString()).toBe("a = 1\n");
    expect(v.transactions[0].annotation(ExternalChange)).toBeUndefined();
  });
});
