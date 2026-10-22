import { Chunk } from "@codemirror/merge";
import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  gitChangeGutter,
  lineChanges,
  markedLines,
  setGitBase,
} from "./gitGutter";

const text = (s: string) => Text.of(s.split("\n"));
const changes = (base: string, doc: string) =>
  lineChanges(Chunk.build(text(base), text(doc)), text(doc));

describe("lineChanges", () => {
  it("marks added and modified lines", () => {
    expect(changes("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([
      { line: 2, kind: "modified" },
      { line: 4, kind: "added" },
    ]);
  });

  it("marks where lines were removed", () => {
    expect(changes("a\nb\nc\n", "a\nc\n")).toEqual([
      { line: 2, kind: "removed-above" },
    ]);
    expect(changes("a\nb\n", "a\n")).toEqual([
      { line: 2, kind: "removed-above" },
    ]);
  });

  it("reports nothing for an unchanged file", () => {
    expect(changes("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("marks every line of a rewritten block", () => {
    expect(changes("x\n", "x\n1\n2\n3\n").map((c) => c.line)).toEqual([
      2, 3, 4,
    ]);
  });
});

describe("gitChangeGutter", () => {
  it("follows edits made after the base was set", () => {
    const base = "one\ntwo\nthree\nfour\nfive\nsix\n";
    let state = EditorState.create({ doc: base, extensions: gitChangeGutter });
    state = state.update({ effects: setGitBase.of(base) }).state;
    expect(markedLines(state)).toEqual([]);
    state = state.update({ changes: { from: 0, insert: "new\n" } }).state;
    expect(markedLines(state)).toEqual([1]);
    const five = state.doc.line(6);
    state = state.update({
      changes: { from: five.from, to: five.to, insert: "FIVE" },
    }).state;
    expect(markedLines(state)).toEqual([1, 6]);
  });

  it("clears outside a repository", () => {
    let state = EditorState.create({ doc: "a\n", extensions: gitChangeGutter });
    state = state.update({ effects: setGitBase.of("b\n") }).state;
    expect(markedLines(state)).toEqual([1]);
    state = state.update({ effects: setGitBase.of(null) }).state;
    expect(markedLines(state)).toEqual([]);
  });
});
