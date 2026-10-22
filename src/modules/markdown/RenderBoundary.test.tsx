import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RenderBoundary } from "./RenderBoundary";

describe("RenderBoundary", () => {
  it("renders its children while nothing failed", () => {
    expect(
      renderToStaticMarkup(
        <RenderBoundary resetKey="a" fallback={() => "failed"}>
          <p>ok</p>
        </RenderBoundary>,
      ),
    ).toBe("<p>ok</p>");
  });

  it("keeps the error for the fallback", () => {
    const error = new Error("boom");
    expect(RenderBoundary.getDerivedStateFromError(error)).toEqual({
      failed: true,
      error,
    });
  });

  it("tries new content again after a failure, and only new content", () => {
    const failed = { failed: true, error: new Error("boom"), resetKey: "a" };
    const props = (resetKey: string) => ({
      resetKey,
      fallback: () => null,
      children: null,
    });
    expect(RenderBoundary.getDerivedStateFromProps(props("a"), failed)).toBe(
      null,
    );
    expect(RenderBoundary.getDerivedStateFromProps(props("b"), failed)).toEqual(
      { failed: false, error: null, resetKey: "b" },
    );
  });
});
