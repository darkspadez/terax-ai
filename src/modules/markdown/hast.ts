// Minimal structural view of hast nodes for the preview's rehype steps;
// avoids depending on the transitive @types/hast package.
export type HNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
};
