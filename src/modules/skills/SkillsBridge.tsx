import { lazy, Suspense } from "react";

const SkillsWatcher = lazy(() =>
  import("./SkillsWatcher").then((m) => ({ default: m.SkillsWatcher })),
);

type Props = {
  /** The project this window works in. */
  root: string | null;
  openFileTab: (path: string) => void;
};

/** Mounted by every app window: project trust and skill editing, loaded after first paint. */
export function SkillsBridge(props: Props) {
  return (
    <Suspense fallback={null}>
      <SkillsWatcher {...props} />
    </Suspense>
  );
}
