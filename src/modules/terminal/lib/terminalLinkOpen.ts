/**
 * Opens a link clicked in a terminal: URLs in the browser, files in the
 * editor (at their line), local folders in the system file manager. The
 * resolving code loads on the first click.
 */
export function openTerminalLink(
  uri: string,
  cwd: string | null,
  onExternalSettled: () => void,
): Promise<void> {
  return import("./terminalLinkTargets").then((links) =>
    links.openTerminalLinkTarget(uri, cwd, onExternalSettled),
  );
}

type FileOpener = (
  path: string,
  line: number | null,
  column: number | null,
) => void;

let fileOpener: FileOpener | null = null;

/** The app's editor registers how to open a file (at a line) from a terminal. */
export function setTerminalFileOpener(opener: FileOpener | null): void {
  fileOpener = opener;
}

/** Opens a file in the editor; false when no editor is registered. */
export function openTerminalFile(
  path: string,
  line: number | null,
  column: number | null,
): boolean {
  if (!fileOpener) return false;
  fileOpener(path, line, column);
  return true;
}
