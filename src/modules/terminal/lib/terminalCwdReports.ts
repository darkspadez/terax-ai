/**
 * The folders a terminal reports (OSC 7), each taken only once the backend has
 * checked it and authorized it (`pty_authorize_cwd`). A report is terminal
 * output, which any program can print, so an unchecked one changes nothing:
 * not the tab's folder, the explorer, a restart's folder or what a restored
 * window authorizes.
 *
 * One check runs at a time and a burst keeps only its latest report, so a
 * flood of reports costs one request at a time. A report equal to the folder
 * already taken costs nothing (shells report at every prompt), and a refused
 * one is checked again when reported again, so a check that lost a race with
 * a second `cd` does not stick.
 */
export class TerminalCwdReports {
  private taken: string | null = null;
  private checking: string | null = null;
  private latest: string | null = null;
  private epoch = 0;

  constructor(
    private readonly check: (cwd: string) => Promise<boolean>,
    private readonly take: (cwd: string) => void,
  ) {}

  report(cwd: string): void {
    if (this.checking !== null) {
      this.latest = cwd === this.checking ? null : cwd;
      return;
    }
    if (cwd === this.taken) return;
    this.run(cwd);
  }

  /** A new shell: forgets the taken folder and drops any answer still due. */
  reset(): void {
    this.epoch += 1;
    this.taken = null;
    this.checking = null;
    this.latest = null;
  }

  private run(cwd: string): void {
    const epoch = this.epoch;
    this.checking = cwd;
    void this.check(cwd)
      .catch(() => false)
      .then((trusted) => {
        if (epoch !== this.epoch) return;
        this.checking = null;
        const next = this.latest;
        this.latest = null;
        // A newer report supersedes this answer: the shell has moved on.
        if (next !== null) {
          this.report(next);
          return;
        }
        if (!trusted) return;
        this.taken = cwd;
        this.take(cwd);
      });
  }
}
