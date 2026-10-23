import { useMemo } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import { splitFrontmatter } from "./frontmatter";
import { MarkdownImage } from "./MarkdownImage";
import "./markdownPreview.css";
import { useMathPlugins } from "./math";
import { PreviewCode, PreviewPre } from "./PreviewCode";
import { PreviewLink } from "./PreviewLink";
import { previewRehypePlugins } from "./previewPipeline";

// GitHub's markup for the elements the preview's stylesheet styles:
// Streamdown's own carry chat styling, its tables a toolbar and a 300px
// scroll box, and its paragraph drops one that holds a lone image, with the
// `align="center"` READMEs centre their logos with.
const components: StreamdownProps["components"] = {
  a: PreviewLink,
  code: PreviewCode,
  pre: PreviewPre,
  img: MarkdownImage,
  p: "p",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  ul: "ul",
  ol: "ol",
  li: "li",
  blockquote: "blockquote",
  hr: "hr",
  strong: "strong",
  sup: "sup",
  sub: "sub",
  table: "table",
  thead: "thead",
  tbody: "tbody",
  tr: "tr",
  th: "th",
  td: "td",
};

/**
 * A Markdown file as the preview shows it, inside the pane's `.markdown-body`
 * (markdownPreview.css): a leading YAML frontmatter block as a key/value
 * table, its values as plain text, then the document through the preview's
 * rehype chain. Math loads with the first file that has any.
 */
export function RenderedMarkdown({
  content,
  baseDir,
}: {
  content: string;
  /** The file's folder, which relative images resolve against. */
  baseDir: string;
}) {
  const { entries, body } = splitFrontmatter(content);
  const plugins = useMathPlugins(body);
  // Stable per folder so Streamdown's processor cache keeps hitting.
  const rehypePlugins = useMemo(() => previewRehypePlugins(baseDir), [baseDir]);
  return (
    <>
      {entries.length > 0 && (
        <table className="markdown-frontmatter">
          <tbody>
            {entries.map(([key, value], i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: keys may repeat; the list never reorders
              <tr key={`${key}-${i}`}>
                <th
                  scope="row"
                  className="w-px whitespace-nowrap text-left align-top"
                >
                  {key}
                </th>
                <td className="whitespace-pre-wrap align-top">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* space-y-0 replaces Streamdown's block spacing; the stylesheet
          spaces blocks as GitHub does. */}
      <Streamdown
        className="space-y-0"
        components={components}
        rehypePlugins={rehypePlugins}
        plugins={plugins}
        mode="static"
        parseIncompleteMarkdown={false}
      >
        {body}
      </Streamdown>
    </>
  );
}
