import { IS_WINDOWS } from "./platform";

export function quoteShellArg(value: string, windows = IS_WINDOWS): string {
  if (windows) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The line that changes a shell's directory to `path`. `shell` is the shell's
 * name or path (`pwsh`, `C:\Windows\System32\cmd.exe`, `zsh`); WSL shells
 * and bash or zsh on Windows quote the POSIX way, cmd.exe needs `/d` to change
 * drive and double quotes.
 */
export function cdCommandLine(
  path: string,
  shell: string | null,
  wsl = false,
  windows = IS_WINDOWS,
): string {
  const name = (shell ?? "")
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  if (!wsl && windows && name === "cmd") return `cd /d "${path}"`;
  const powershell = !wsl && windows && name !== "bash" && name !== "zsh";
  return `cd ${quoteShellArg(path, powershell)}`;
}
