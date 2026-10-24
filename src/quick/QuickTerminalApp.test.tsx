import { describe, expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({
  dispose: vi.fn(),
  hide: vi.fn(),
  leaf: 1,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [
    initial === 1 ? session.leaf : initial,
    (next: number) => {
      session.leaf = next;
    },
  ],
  useEffect: () => {},
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (select: (state: unknown) => unknown) =>
    select({
      hydrated: true,
      terminalBehavior: { quickTerminalAutohide: true },
    }),
}));
vi.mock("@/modules/terminal", () => ({
  disposeSession: session.dispose,
  TerminalPromptDialog: () => null,
}));
vi.mock("@/modules/terminal/TerminalPane", () => ({
  TerminalPane: () => null,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide: session.hide }),
}));
import { QuickTerminalApp } from "./QuickTerminalApp";

describe("quick terminal lifecycle", () => {
  it("disposes every exited leaf before replacing it", () => {
    for (let leaf = 1; leaf <= 3; leaf++) {
      const app = QuickTerminalApp();
      const main = app.props.children[0];
      const pane = main.props.children;
      expect(pane.props.leafId).toBe(leaf);
      pane.props.onExit();
      expect(session.dispose).toHaveBeenLastCalledWith(leaf);
      expect(session.leaf).toBe(leaf + 1);
    }
    expect(session.dispose).toHaveBeenCalledTimes(3);
    expect(session.hide).toHaveBeenCalledTimes(3);
  });
});
