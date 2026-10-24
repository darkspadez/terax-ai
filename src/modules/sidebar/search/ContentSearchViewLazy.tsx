import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";
import type { ContentSearchView as ContentSearchViewType } from "./ContentSearchView";

const ContentSearchViewInner = lazy(() =>
  import("./ContentSearchView").then((m) => ({
    default: m.ContentSearchView,
  })),
);

type Props = ComponentProps<typeof ContentSearchViewType>;

export function ContentSearchView(props: Props) {
  return (
    <Suspense fallback={null}>
      <ContentSearchViewInner {...props} />
    </Suspense>
  );
}
