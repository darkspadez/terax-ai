import type { MouseEvent, ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const scrollToFragment = vi.fn();
vi.mock("./headingAnchors", () => ({ scrollToFragment }));

const { PreviewLink } = await import("./PreviewLink");

function click(href: string) {
  const element = PreviewLink({ href, children: "x" }) as ReactElement<{
    onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  }>;
  const event = {
    preventDefault: vi.fn(),
    currentTarget: {},
  } as unknown as MouseEvent<HTMLAnchorElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
  element.props.onClick(event);
  return event;
}

describe("PreviewLink", () => {
  it("scrolls the pane to an in-page section", () => {
    expect(click("#setup").preventDefault).toHaveBeenCalled();
    expect(scrollToFragment).toHaveBeenCalledWith({}, "setup");
  });

  it("never navigates the app to a relative file link", () => {
    expect(click("/docs/CONTRIBUTING.md").preventDefault).toHaveBeenCalled();
  });

  it("leaves external links to the system opener", () => {
    expect(click("https://example.com").preventDefault).not.toHaveBeenCalled();
  });
});
