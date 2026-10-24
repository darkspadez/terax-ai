import { beforeEach, expect, it } from "vitest";
import {
  TERMINAL_FONT_OFFSET_LIMIT,
  useTerminalFontOffsets,
} from "./terminalFontOffsets";

beforeEach(() => useTerminalFontOffsets.setState({ offsets: {} }));

it("adjusts one pane's font size within bounds and resets it", () => {
  const { adjust, clear } = useTerminalFontOffsets.getState();
  adjust(1, 2);
  adjust(1, 1);
  adjust(2, -1);
  expect(useTerminalFontOffsets.getState().offsets).toEqual({ 1: 3, 2: -1 });
  adjust(1, 1000);
  expect(useTerminalFontOffsets.getState().offsets[1]).toBe(
    TERMINAL_FONT_OFFSET_LIMIT,
  );
  adjust(1, "reset");
  clear(2);
  expect(useTerminalFontOffsets.getState().offsets).toEqual({});
});
