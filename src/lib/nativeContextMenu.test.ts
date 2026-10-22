import { describe, expect, it, vi } from "vitest";
import {
  allowsNativeContextMenu,
  installNativeContextMenuGuard,
  isPrimaryClick,
} from "./nativeContextMenu";

type FakeNode = {
  readonly tagName: string;
  readonly parentElement: FakeNode | null;
  getAttribute(name: string): string | null;
  closest(selector: string): FakeNode | null;
};

/** Matches `tag`, `[attr]` and `tag[attr]` lists, all these tests need. */
function matches(node: FakeNode, selector: string): boolean {
  return selector.split(",").some((part) => {
    const match = /^([a-z]*)(?:\[([\w-]+)\])?$/.exec(part.trim());
    if (!match) throw new Error(`unsupported selector ${part}`);
    const [, tag, attribute] = match;
    return (
      (!tag || node.tagName === tag.toUpperCase()) &&
      (!attribute || node.getAttribute(attribute) !== null)
    );
  });
}

function element(
  tag: string,
  attributes: Record<string, string> = {},
  parent: FakeNode | null = null,
): FakeNode {
  const node: FakeNode = {
    tagName: tag.toUpperCase(),
    parentElement: parent,
    getAttribute: (name) => attributes[name] ?? null,
    closest(selector) {
      for (let at: FakeNode | null = node; at; at = at.parentElement) {
        if (matches(at, selector)) return at;
      }
      return null;
    },
  };
  return node;
}

const target = (node: unknown) => node as EventTarget;

function selectionOf(...nodes: FakeNode[]) {
  return {
    isCollapsed: false,
    containsNode: (node: Node) =>
      nodes.some((selected) => {
        for (
          let at: FakeNode | null = node as unknown as FakeNode;
          at;
          at = at.parentElement
        ) {
          if (at === selected) return true;
        }
        return false;
      }),
  };
}

describe("allowsNativeContextMenu", () => {
  const body = element("body");
  const header = element("header", { "data-tauri-drag-region": "" }, body);

  it("refuses the page menu (Reload) on chrome", () => {
    expect(allowsNativeContextMenu(target(header), null)).toBe(false);
    expect(
      allowsNativeContextMenu(target(element("div", {}, header)), null),
    ).toBe(false);
    expect(allowsNativeContextMenu(null, null)).toBe(false);
  });

  it("keeps the text menu in fields that edit text", () => {
    for (const field of [
      element("textarea", {}, body),
      element("input", {}, body),
      element("input", { type: "Search" }, body),
      element("span", {}, element("div", { contenteditable: "true" }, body)),
    ]) {
      expect(allowsNativeContextMenu(target(field), null)).toBe(true);
    }
    for (const control of [
      element("input", { type: "checkbox" }, body),
      element("input", { type: "button" }, body),
      element("div", { contenteditable: "false" }, body),
    ]) {
      expect(allowsNativeContextMenu(target(control), null)).toBe(false);
    }
  });

  it("keeps the menu the terminal prepares for its selection", () => {
    const surface = element("div", { "data-terax-terminal-surface": "" }, body);
    expect(
      allowsNativeContextMenu(target(element("canvas", {}, surface)), null),
    ).toBe(true);
  });

  it("keeps Copy on selected text, but not on links or images in it", () => {
    const paragraph = element("p", {}, body);
    const text = { parentElement: paragraph };
    const link = element("a", { href: "https://example.com" }, paragraph);
    const image = element("img", { src: "x.png" }, paragraph);
    const selection = selectionOf(paragraph);
    expect(allowsNativeContextMenu(target(text), selection)).toBe(true);
    expect(allowsNativeContextMenu(target(link), selection)).toBe(false);
    expect(allowsNativeContextMenu(target(image), selection)).toBe(false);
    expect(
      allowsNativeContextMenu(target(text), {
        ...selection,
        isCollapsed: true,
      }),
    ).toBe(false);
    // A selection elsewhere does not turn this click into a text click.
    expect(allowsNativeContextMenu(target(header), selection)).toBe(false);
  });
});

describe("installNativeContextMenuGuard", () => {
  it("prevents only what the page left alone and the webview may not show", () => {
    let listener: ((event: MouseEvent) => void) | undefined;
    installNativeContextMenuGuard({
      addEventListener: ((
        type: string,
        handler: (event: MouseEvent) => void,
      ) => {
        expect(type).toBe("contextmenu");
        listener = handler;
      }) as Window["addEventListener"],
      getSelection: () => null,
    });
    const fire = (node: FakeNode, defaultPrevented = false) => {
      const event = {
        target: node,
        defaultPrevented,
        preventDefault: vi.fn(),
      };
      listener?.(event as unknown as MouseEvent);
      return event.preventDefault;
    };
    const body = element("body");
    expect(fire(element("div", {}, body))).toHaveBeenCalledOnce();
    expect(fire(element("textarea", {}, body))).not.toHaveBeenCalled();
    // A menu of ours (Radix) already took the click.
    expect(fire(element("div", {}, body), true)).not.toHaveBeenCalled();
  });
});

describe("isPrimaryClick", () => {
  it("leaves out clicks that open a context menu or paste", () => {
    expect(isPrimaryClick({ button: 0, ctrlKey: false }, true)).toBe(true);
    expect(isPrimaryClick({ button: 2, ctrlKey: false }, false)).toBe(false);
    expect(isPrimaryClick({ button: 1, ctrlKey: false }, false)).toBe(false);
    // Control-click is the macOS context click; elsewhere it is a click.
    expect(isPrimaryClick({ button: 0, ctrlKey: true }, true)).toBe(false);
    expect(isPrimaryClick({ button: 0, ctrlKey: true }, false)).toBe(true);
  });
});
