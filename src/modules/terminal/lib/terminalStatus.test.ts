import { beforeEach, describe, expect, it } from "vitest";
import {
  selectTerminalTabStatus,
  terminalLeafStatus,
  useTerminalStatusStore,
} from "./terminalStatus";

describe("terminal pane status", () => {
  beforeEach(() => useTerminalStatusStore.setState({ leaves: {} }));

  it("keeps the store identical when nothing changes", () => {
    const { update } = useTerminalStatusStore.getState();
    update(1, { title: "vim", progress: { state: "set", value: 5 } });
    const before = useTerminalStatusStore.getState().leaves;
    update(1, { title: "vim", progress: { state: "set", value: 5 } });
    expect(useTerminalStatusStore.getState().leaves).toBe(before);
    update(1, { progress: { state: "set", value: 6 } });
    expect(useTerminalStatusStore.getState().leaves).not.toBe(before);
    expect(terminalLeafStatus(1)).toMatchObject({
      title: "vim",
      running: false,
    });
  });

  it("clears bells the user acknowledged and forgets closed panes", () => {
    const { update, acknowledgeBell, clear } =
      useTerminalStatusStore.getState();
    update(1, { bell: true });
    update(2, { bell: true });
    acknowledgeBell([1]);
    expect(terminalLeafStatus(1).bell).toBe(false);
    expect(terminalLeafStatus(2).bell).toBe(true);
    clear(2);
    expect(useTerminalStatusStore.getState().leaves[2]).toBeUndefined();
  });

  it("summarizes a tab: running title of the active pane, worst progress, any bell", () => {
    const leaves = {
      1: {
        title: "htop",
        progress: { state: "set", value: 10 },
        bell: false,
        running: true,
      },
      2: {
        title: "make",
        progress: { state: "error", value: 80 },
        bell: true,
        running: false,
      },
    } as const;
    expect(selectTerminalTabStatus(leaves, [1, 2], 1)).toEqual({
      title: "htop",
      progress: { state: "error", value: 80 },
      bell: true,
    });
    // A title from a finished command (or a prompt) is not shown.
    expect(selectTerminalTabStatus(leaves, [1, 2], 2).title).toBeNull();
    expect(selectTerminalTabStatus(leaves, [3], 3)).toEqual({
      title: null,
      progress: null,
      bell: false,
    });
  });
});
