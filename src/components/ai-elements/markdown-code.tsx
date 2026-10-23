"use client";

import { MermaidBlock } from "@/modules/markdown/MermaidBlock";
import { isValidElement, type ReactNode } from "react";

import { ChatCodeBlock } from "./chat-code";

export function markdownCodeText(children?: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => markdownCodeText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return markdownCodeText(children.props.children);
  }
  return "";
}

/**
 * The language of a Streamdown `code` element: null for inline code, else
 * the block's info string ("" for a fence without one or an indented
 * block). Streamdown's `pre` marks the code of every block with
 * `data-block`; the language is the whole word after `language-`, as
 * Streamdown reads it, so `c++` and `objective-c` survive.
 */
export function codeBlockLanguage(
  className: string | undefined,
  props: object,
): string | null {
  if (!("data-block" in props)) return null;
  return className?.match(/language-(\S+)/)?.[1] ?? "";
}

/**
 * Streamdown `components.code` override. Inline code stays a plain pill;
 * blocks delegate to the Lezer-based renderer, `mermaid` ones to the
 * diagram renderer.
 */
export function MarkdownCode({
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
  if (lang === null) {
    return (
      <code
        className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[0.875em] text-foreground"
        {...rest}
      >
        {children}
      </code>
    );
  }

  const code = markdownCodeText(children).replace(/\n$/, "");
  if (lang === "mermaid") return <MermaidBlock code={code} />;
  return <ChatCodeBlock code={code} lang={lang || null} />;
}
