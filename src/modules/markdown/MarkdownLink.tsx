import { isExternalUrl, openExternalUrl } from "@/lib/external-link";
import type { ComponentProps, MouseEvent, MouseEventHandler } from "react";

export type MarkdownLinkProps = ComponentProps<"a"> & {
  node?: unknown;
  onSettled?: () => void;
};

export function MarkdownLink({
  children,
  href,
  node: _node,
  onClick,
  onSettled,
  ...props
}: MarkdownLinkProps) {
  // The webview must never navigate itself or open a window of its own:
  // external links go to the system's opener.
  const openExternal = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || !href || !isExternalUrl(href)) return;
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(href, onSettled);
  };

  const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    onClick?.(event);
    openExternal(event);
  };

  // auxclick also fires for the right button, which must keep its menu.
  const handleAuxClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (event.button === 1) openExternal(event);
  };

  return (
    <a
      {...props}
      href={href}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
