import { Component, type ReactNode } from "react";

type Props = {
  /** A new key (new content) gets a fresh attempt after a failure. */
  resetKey: string;
  fallback: (error: unknown) => ReactNode;
  children: ReactNode;
};

type State = { failed: boolean; error: unknown; resetKey: string };

/**
 * Contains a failed render of Markdown, a formula or a diagram: the app
 * mounts no error boundary of its own, so an uncaught render error would
 * blank the whole window. Based on crynta/terax-ai#1037 by @Gimics.
 */
export class RenderBoundary extends Component<Props, State> {
  state: State = { failed: false, error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  // Content arrives without a remount (a file changed on disk, a streamed
  // message grew), so one failure must not pin the fallback for good.
  static getDerivedStateFromProps(
    props: Props,
    state: State,
  ): Partial<State> | null {
    if (props.resetKey === state.resetKey) return null;
    return { failed: false, error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown) {
    console.error("[markdown] render failed", error);
  }

  render() {
    return this.state.failed
      ? this.props.fallback(this.state.error)
      : this.props.children;
  }
}
