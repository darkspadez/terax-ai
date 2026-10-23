import { CopyButton, HighlightedPre } from "@/components/ai-elements/chat-code";
import {
  codeBlockLanguage,
  markdownCodeText,
} from "@/components/ai-elements/markdown-code";
import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { MermaidBlock } from "./MermaidBlock";

/**
 * Streamdown `components.code` of the Markdown preview. A file from disk is
 * something to read, not an answer to act on: its shell blocks never offer
 * to type themselves into the active terminal. Run in terminal belongs to AI
 * chat replies (MarkdownCode, ChatCodeBlock). Blocks show as on GitHub:
 * highlighted, without a language label, with a copy button on hover (the
 * chat's highlighter, restyled by markdownPreview.css).
 */
export function PreviewCode({
  className,
  children,
  node: _node,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
  node?: unknown;
}) {
  const lang = codeBlockLanguage(className, rest);
  if (lang === null) return <code {...rest}>{children}</code>;
  const code = markdownCodeText(children).replace(/\n$/, "");
  if (lang === "mermaid") return <MermaidBlock code={code} />;
  return (
    <div className="markdown-code-block">
      <HighlightedPre code={code} lang={lang} />
      <div className="markdown-code-copy">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

/**
 * Streamdown's `pre` hands every block to `code` and drops its own element,
 * so a raw `<pre>` written without code inside lost its whitespace. This one
 * does so only for a block's code element.
 */
export function PreviewPre({
  children,
  node: _node,
  ...props
}: ComponentProps<"pre"> & { node?: unknown }) {
  if (isValidElement(children) && children.type === PreviewCode) {
    return cloneElement(children as ReactElement<Record<string, unknown>>, {
      "data-block": "true",
    });
  }
  return <pre {...props}>{children}</pre>;
}
