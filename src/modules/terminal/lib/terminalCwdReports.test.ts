import { describe, expect, it, vi } from "vitest";
import { TerminalCwdReports } from "./terminalCwdReports";

/** A backend whose answers the test gives, one pending check at a time. */
function harness() {
  const answers: ((trusted: boolean) => void)[] = [];
  const check = vi.fn(
    (_cwd: string) =>
      new Promise<boolean>((resolve) => {
        answers.push(resolve);
      }),
  );
  const take = vi.fn<(cwd: string) => void>();
  const reports = new TerminalCwdReports(check, take);
  const answer = async (trusted: boolean) => {
    const resolve = answers.shift();
    if (!resolve) throw new Error("no check is pending");
    resolve(trusted);
    // The answer, its catch and its then.
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };
  return { reports, check, take, answer };
}

describe("terminal folder reports", () => {
  it("takes a folder only once the backend has checked it", async () => {
    const { reports, check, take, answer } = harness();
    reports.report("/home/me/project");
    expect(take).not.toHaveBeenCalled();
    await answer(true);
    expect(check.mock.calls).toEqual([["/home/me/project"]]);
    expect(take.mock.calls).toEqual([["/home/me/project"]]);
  });

  it("changes nothing for a report the backend refuses", async () => {
    const { reports, take, answer } = harness();
    reports.report("/home/me");
    await answer(true);
    reports.report("/");
    await answer(false);
    expect(take.mock.calls).toEqual([["/home/me"]]);
  });

  it("asks nothing when a shell reports its folder again at each prompt", async () => {
    const { reports, check, answer } = harness();
    reports.report("/home/me");
    await answer(true);
    reports.report("/home/me");
    reports.report("/home/me");
    expect(check).toHaveBeenCalledOnce();
  });

  it("checks a refused folder again when it is reported again", async () => {
    const { reports, check, take, answer } = harness();
    reports.report("/srv/a");
    await answer(false);
    reports.report("/srv/a");
    await answer(true);
    expect(check).toHaveBeenCalledTimes(2);
    expect(take.mock.calls).toEqual([["/srv/a"]]);
  });

  it("keeps one check at a time and only the latest report of a burst", async () => {
    const { reports, check, take, answer } = harness();
    reports.report("/first");
    for (let i = 0; i < 1000; i++) reports.report(`/flood/${i}`);
    expect(check).toHaveBeenCalledOnce();
    // The first answer is superseded: the shell has moved on.
    await answer(true);
    expect(take).not.toHaveBeenCalled();
    expect(check.mock.calls).toEqual([["/first"], ["/flood/999"]]);
    await answer(true);
    expect(take.mock.calls).toEqual([["/flood/999"]]);
  });

  it("does not check again a report equal to the one being checked", async () => {
    const { reports, check, take, answer } = harness();
    reports.report("/a");
    reports.report("/b");
    reports.report("/a");
    await answer(true);
    expect(check).toHaveBeenCalledOnce();
    expect(take.mock.calls).toEqual([["/a"]]);
  });

  it("drops a superseded report that returns to the folder already taken", async () => {
    const { reports, check, take, answer } = harness();
    reports.report("/home/me");
    await answer(true);
    // `cd elsewhere; cd -` faster than the check: the shell is back.
    reports.report("/elsewhere");
    reports.report("/home/me");
    await answer(false);
    expect(check).toHaveBeenCalledTimes(2);
    expect(take.mock.calls).toEqual([["/home/me"]]);
  });

  it("treats a failed check as a refusal", async () => {
    const take = vi.fn();
    const reports = new TerminalCwdReports(
      () => Promise.reject(new Error("no session")),
      take,
    );
    reports.report("/home/me");
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(take).not.toHaveBeenCalled();
  });

  it("drops an answer that arrives after a new shell started", async () => {
    const { reports, check, take, answer } = harness();
    reports.report("/old");
    reports.reset();
    await answer(true);
    expect(take).not.toHaveBeenCalled();
    reports.report("/old");
    await answer(true);
    expect(check).toHaveBeenCalledTimes(2);
    expect(take.mock.calls).toEqual([["/old"]]);
  });
});
