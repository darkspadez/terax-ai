import { isExternalUrl } from "@/lib/external-link";
import { scrollToFragment } from "./headingAnchors";
import { MarkdownLink, type MarkdownLinkProps } from "./MarkdownLink";

/**
 * Links of the rendered file: external ones go to the system opener, an
 * in-page "#section" scrolls this pane, and anything else (a relative file
 * link) never navigates the app's webview.
 */
export function PreviewLink({ href, ...props }: MarkdownLinkProps) {
  return (
    <MarkdownLink
      {...props}
      href={href}
      onClick={(event) => {
        if (!href || isExternalUrl(href)) return;
        event.preventDefault();
        if (href.startsWith("#")) {
          scrollToFragment(event.currentTarget, href.slice(1));
        }
      }}
    />
  );
}
