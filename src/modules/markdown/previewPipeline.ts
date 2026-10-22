import { defaultRehypePlugins, type StreamdownProps } from "streamdown";
import { rehypeGithubAlerts } from "./githubAlerts";
import { rehypeHeadingAnchors } from "./headingAnchors";
import { rehypeLocalImages } from "./localImages";

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;
type SanitizeSchema = {
  attributes?: Record<string, unknown[]>;
};

const [rehypeSanitize, streamdownSchema] = defaultRehypePlugins.sanitize as [
  unknown,
  SanitizeSchema,
];

// HTML from a previewed file must never gain markup the sanitizer would not
// let through; the alert classes are enumerated, never a blanket className.
// Ids and names get GitHub's prefix again (Streamdown drops it), so a heading
// can never clobber an id of the app's own DOM.
const previewSchema = {
  ...streamdownSchema,
  clobberPrefix: "user-content-",
  attributes: {
    ...streamdownSchema.attributes,
    div: [
      ...(streamdownSchema.attributes?.div ?? []),
      [
        "className",
        "markdown-alert",
        "markdown-alert-note",
        "markdown-alert-tip",
        "markdown-alert-important",
        "markdown-alert-warning",
        "markdown-alert-caution",
      ],
    ],
    p: [
      ...(streamdownSchema.attributes?.p ?? []),
      ["className", "markdown-alert-title"],
    ],
  },
};

/**
 * Streamdown's chain for the rendered preview, in a load-bearing order:
 * GitHub alerts and heading ids are added before the sanitizer vets them,
 * relative images resolve after it (so an asset: URL written in the file is
 * still stripped) and before harden, which vets every URL last.
 */
export function previewRehypePlugins(baseDir: string): RehypePlugins {
  const plugins: RehypePlugins = [];
  for (const [name, plugin] of Object.entries(defaultRehypePlugins)) {
    if (name === "sanitize") {
      plugins.push(rehypeGithubAlerts, rehypeHeadingAnchors, [
        rehypeSanitize,
        previewSchema,
      ] as RehypePlugins[number]);
    } else if (name === "harden") {
      plugins.push([rehypeLocalImages, baseDir], plugin);
    } else {
      plugins.push(plugin);
    }
  }
  return plugins;
}
