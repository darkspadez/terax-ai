import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { EntryRow, type EntryRowProps } from "./TreeRow";

type ButtonProps = { onDoubleClick: () => void };

function row(overrides: Partial<EntryRowProps>) {
  const props: EntryRowProps = {
    path: "/repo/a.ts",
    name: "a.ts",
    isDir: false,
    isExpanded: false,
    depth: 0,
    actions: {
      toggle: vi.fn(),
      commitRename: vi.fn(),
      cancelRename: vi.fn(),
    },
    renameInProgress: false,
    isSelected: false,
    isRenaming: false,
    onOpenFile: vi.fn(),
    onSelectPath: vi.fn(),
    ...overrides,
  };
  // The row is a memoized plain function: render it to its button element.
  const render = (
    EntryRow as unknown as { type: (p: EntryRowProps) => unknown }
  ).type;
  return { props, button: render(props) as ReactElement<ButtonProps> };
}

describe("EntryRow double-click", () => {
  it("keeps a file open in its own tab", () => {
    const { props, button } = row({});
    button.props.onDoubleClick();
    expect(props.onOpenFile).toHaveBeenCalledWith("/repo/a.ts", true);
  });

  it("leaves folders and a row being renamed alone", () => {
    const folder = row({ isDir: true, path: "/repo/src", name: "src" });
    folder.button.props.onDoubleClick();
    expect(folder.props.onOpenFile).not.toHaveBeenCalled();

    const busy = row({ renameInProgress: true });
    busy.button.props.onDoubleClick();
    expect(busy.props.onOpenFile).not.toHaveBeenCalled();
  });
});
