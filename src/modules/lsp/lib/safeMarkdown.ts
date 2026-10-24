import { type Marked, marked, type Tokens } from "marked";

const WEB_OR_MAIL = /^(https?:|mailto:)/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const installed = new WeakSet<object>();

/**
 * Makes `marked.parse` safe for language server docs. The LSP library renders
 * hover and completion docs with it straight into `innerHTML`, and those docs
 * come from comments in any dependency: raw HTML in them shows as text, links
 * keep only web and mail targets and open in the browser (the opener plugin
 * takes `target="_blank"` clicks; a plain link would navigate the app's own
 * window), and images show their alt text. It changes rendering only, so
 * Streamdown and Mermaid, which use the lexer of this shared instance, are
 * unaffected; the LSP library is its only `parse` caller.
 */
export function installSafeMarkdown(target: Marked | typeof marked = marked) {
  if (installed.has(target)) return;
  installed.add(target);
  target.use({
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(token.text);
      },
      link(token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens);
        if (!WEB_OR_MAIL.test(token.href.trim())) return text;
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<a href="${escapeHtml(token.href.trim())}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
      image(token: Tokens.Image) {
        return escapeHtml(token.text);
      },
    },
  });
}
