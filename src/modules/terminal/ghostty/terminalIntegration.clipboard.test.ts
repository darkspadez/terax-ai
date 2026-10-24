import { describe, expect, it, vi } from "vitest";
const clipboard = vi.hoisted(() => ({
  readPrimarySelection: vi.fn(async () => "primary"),
  readTerminalClipboard: vi.fn(async () => "clipboard"),
  readClipboardImage: vi.fn(),
}));
vi.mock("../lib/terminalClipboard", () => clipboard);
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ terminalBehavior: { clipboardRead: "allow" } }),
  },
}));
import {
  clipboardReadReply,
  terminalIntegrationCallbacks,
} from "./terminalIntegration";

describe("OSC52 selection reads", () => {
  it.each([
    ["p", "primary"],
    ["c", "clipboard"],
    ["s", "clipboard"],
    ["q", ""],
  ])("reads selection %s from its own source", async (selection, text) => {
    const reply = vi.fn();
    const callbacks = terminalIntegrationCallbacks({
      leafId: 1,
      reply,
      userIsLooking: () => true,
      answerKittyClipboardRead: vi.fn(),
      pointerTarget: () => null,
    });
    callbacks.onClipboardRead?.(selection, "st");
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    expect(new TextDecoder().decode(reply.mock.calls[0][0])).toBe(
      clipboardReadReply(selection, text, "st"),
    );
  });
});
