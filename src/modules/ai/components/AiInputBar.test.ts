import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AiInputBarConnect } from "./AiInputBar";

function findAll(
  node: ReactNode,
  match: (props: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, match));
  if (!isValidElement(node)) return [];
  const props = node.props as Record<string, unknown>;
  return [
    ...(match(props) ? [props] : []),
    ...findAll(props.children as ReactNode, match),
  ];
}

describe("AiInputBarConnect", () => {
  it("can always be closed, since without a provider nothing else closes it", () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    const tree = AiInputBarConnect({ onAdd, onClose });
    const [close] = findAll(tree, (p) => p["aria-label"] === "Close AI panel");
    expect(close?.onClick).toBe(onClose);
    expect(findAll(tree, (p) => p.onClick === onAdd)).toHaveLength(1);
  });
});
