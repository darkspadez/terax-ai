import { describe, expect, it, vi } from "vitest";
import { GhosttySemanticEventRouter } from "./GhosttySemanticEventRouter";

describe("GhosttySemanticEventRouter", () => {
  it("routes cwd only outside untrusted command output", () => {
    const onCwd = vi.fn();
    const router = new GhosttySemanticEventRouter({ onCwd });

    router.handle({ type: "pwd", uri: "file://localhost/Users/terax" });
    router.handle({ type: "prompt-end" });
    router.handle({ type: "pwd", uri: "file://attacker/tmp/ignored" });
    router.handle({ type: "end-of-command", exitCode: 0 });
    router.handle({ type: "pwd", uri: "file://localhost/Users/terax/src" });

    expect(onCwd).toHaveBeenCalledTimes(2);
    expect(onCwd).toHaveBeenNthCalledWith(1, "/Users/terax");
    expect(onCwd).toHaveBeenNthCalledWith(2, "/Users/terax/src");
  });

  it("tracks command execution separately from prompt input", () => {
    const onCommandState = vi.fn();
    const router = new GhosttySemanticEventRouter({ onCommandState });

    router.handle({ type: "prompt-start" });
    router.handle({ type: "prompt-end" });
    router.handle({ type: "end-of-input" });
    router.handle({ type: "end-of-command", exitCode: 7 });

    expect(onCommandState.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("validates and decodes OSC 52 clipboard writes", () => {
    const onClipboard = vi.fn();
    const router = new GhosttySemanticEventRouter({ onClipboard });

    router.handle({
      type: "clipboard",
      selection: "c",
      data: btoa("hello"),
    });
    router.handle({
      type: "clipboard",
      selection: "p",
      data: btoa("ignored"),
    });

    expect(onClipboard).toHaveBeenCalledOnce();
    expect(onClipboard).toHaveBeenCalledWith("hello");
  });

  it("reports bounded-queue overflow", () => {
    const onOverflow = vi.fn();
    const router = new GhosttySemanticEventRouter({ onOverflow });
    router.handle({ type: "overflow", dropped: 3 });
    expect(onOverflow).toHaveBeenCalledWith(3);
  });

  it("routes progress, pointer shapes, clipboard reads and command boundaries", () => {
    const onProgress = vi.fn();
    const onPointerShape = vi.fn();
    const onClipboardRead = vi.fn();
    const onCommandStarted = vi.fn();
    const onCommandFinished = vi.fn();
    const router = new GhosttySemanticEventRouter({
      onProgress,
      onPointerShape,
      onClipboardRead,
      onCommandStarted,
      onCommandFinished,
    });

    router.handle({ type: "progress", state: "set", progress: 40 });
    router.handle({ type: "progress", state: "remove", progress: null });
    router.handle({ type: "pointer-shape", shape: "pointer" });
    router.handle({ type: "clipboard-read", selection: "c", terminator: "bel" });
    router.handle({ type: "end-of-input", marker: 3, command: "make" });
    router.handle({ type: "end-of-input" });
    router.handle({ type: "end-of-command", exitCode: 2 });

    expect(onProgress.mock.calls).toEqual([[{ state: "set", value: 40 }], [null]]);
    expect(onPointerShape).toHaveBeenCalledWith("pointer");
    expect(onClipboardRead).toHaveBeenCalledWith("c", "bel");
    expect(onCommandStarted.mock.calls).toEqual([["make"], [null]]);
    expect(onCommandFinished).toHaveBeenCalledWith(2);
  });

  it("routes Kitty clipboard reads and writes", () => {
    const onKittyClipboardRead = vi.fn();
    const onKittyClipboardWrite = vi.fn();
    const router = new GhosttySemanticEventRouter({
      onKittyClipboardRead,
      onKittyClipboardWrite,
    });
    const read = {
      type: "kitty-clipboard-read",
      id: 3,
      primary: false,
      list: false,
      granted: false,
      name: "vim",
      mimes: ["text/plain"],
    } as const;

    router.handle(read);
    router.handle({
      type: "kitty-clipboard-write",
      primary: true,
      clear: false,
      text: "hi",
    });
    router.handle({
      type: "kitty-clipboard-write",
      primary: false,
      clear: true,
      text: "",
    });
    router.handle({ type: "drag-and-drop", change: "registration" });

    expect(onKittyClipboardRead).toHaveBeenCalledWith(read);
    expect(onKittyClipboardWrite.mock.calls).toEqual([
      ["hi", true],
      ["", false],
    ]);
  });
});
