import { openExternalUrl } from "@/lib/external-link";
import type { MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownLink } from "./MarkdownLink";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

describe("MarkdownLink", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "https://chatgpt.com/codex/settings/usage",
    "mailto:support@example.com",
    "tel:+16045550123",
  ])("opens supported links natively: %s", async (href) => {
    openUrl.mockResolvedValue(undefined);
    const onSettled = vi.fn();

    await openExternalUrl(href, onSettled);

    expect(openUrl).toHaveBeenCalledWith(href);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("still settles when opening fails", async () => {
    openUrl.mockRejectedValue(new Error("browser unavailable"));
    const onSettled = vi.fn();

    await openExternalUrl("https://example.com", onSettled);

    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("does not invoke the native opener for unsupported schemes", async () => {
    const onSettled = vi.fn();

    await openExternalUrl("javascript:alert(1)", onSettled);

    expect(openUrl).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledOnce();
  });
});

type AnchorHandlers = {
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  onAuxClick: (event: MouseEvent<HTMLAnchorElement>) => void;
};

function anchor(href: string) {
  return (
    MarkdownLink({ href, children: "link" }) as ReactElement<AnchorHandlers>
  ).props;
}

function mouse(button: number) {
  return {
    button,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as MouseEvent<HTMLAnchorElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

// crynta/terax-ai#1249: a middle click did nothing useful, and target=_blank
// asked the webview to open a window of its own.
describe("MarkdownLink events", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders no target that would open a webview window", () => {
    const html = renderToStaticMarkup(
      <MarkdownLink href="https://example.com">x</MarkdownLink>,
    );
    expect(html).not.toContain("target=");
  });

  it("opens external links through the opener on click and middle click", () => {
    openUrl.mockResolvedValue(undefined);
    const { onClick, onAuxClick } = anchor("https://example.com/a");
    const click = mouse(0);
    onClick(click);
    expect(click.preventDefault).toHaveBeenCalled();
    onAuxClick(mouse(1));
    expect(openUrl).toHaveBeenCalledTimes(2);
  });

  it("leaves right clicks and in-page links alone", () => {
    const { onAuxClick } = anchor("https://example.com/a");
    const right = mouse(2);
    onAuxClick(right);
    expect(right.preventDefault).not.toHaveBeenCalled();
    anchor("#section").onClick(mouse(0));
    expect(openUrl).not.toHaveBeenCalled();
  });
});
