import { describe, expect, it } from "vitest";
import { cdCommandLine, quoteShellArg } from "./shellQuote";

describe("quoteShellArg (posix)", () => {
  const q = (s: string) => quoteShellArg(s, false);

  it("wraps a plain string in single quotes", () => {
    expect(q("fix the bug")).toBe("'fix the bug'");
  });

  it("escapes embedded single quotes with the '\\'' dance", () => {
    expect(q("it's broken")).toBe("'it'\\''s broken'");
  });

  it("neutralizes shell metacharacters", () => {
    expect(q("a; rm -rf / $(whoami) `id` && b")).toBe(
      "'a; rm -rf / $(whoami) `id` && b'",
    );
  });

  it("quotes an empty string to a real empty argument", () => {
    expect(q("")).toBe("''");
  });

  it("cannot break out of the quoted argument", () => {
    expect(q("'; rm -rf /; '")).toBe("''\\''; rm -rf /; '\\'''");
  });
});

describe("quoteShellArg (windows/pwsh)", () => {
  const q = (s: string) => quoteShellArg(s, true);

  it("wraps a plain string in single quotes", () => {
    expect(q("fix the bug")).toBe("'fix the bug'");
  });

  it("doubles embedded single quotes", () => {
    expect(q("it's broken")).toBe("'it''s broken'");
  });

  it("keeps backticks and $ literal inside single quotes", () => {
    expect(q("$env:PATH `n")).toBe("'$env:PATH `n'");
  });

  it("quotes an empty string", () => {
    expect(q("")).toBe("''");
  });
});

describe("cdCommandLine", () => {
  it("changes drive and quotes the cmd.exe way", () => {
    // crynta/terax-ai#1271: cmd.exe does not take single quotes.
    expect(
      cdCommandLine(
        "D:/work/a b",
        "C:\\Windows\\System32\\cmd.exe",
        false,
        true,
      ),
    ).toBe('cd /d "D:/work/a b"');
  });

  it("quotes for PowerShell on Windows, the default shell there", () => {
    expect(cdCommandLine("C:/it's", "pwsh", false, true)).toBe("cd 'C:/it''s'");
    expect(cdCommandLine("C:/it's", null, false, true)).toBe("cd 'C:/it''s'");
  });

  it("quotes the POSIX way for WSL and for bash on Windows", () => {
    expect(cdCommandLine("/home/it's", "cmd", true, true)).toBe(
      "cd '/home/it'\\''s'",
    );
    expect(cdCommandLine("C:/it's", "C:/Git/bin/bash.exe", false, true)).toBe(
      "cd 'C:/it'\\''s'",
    );
    expect(cdCommandLine("/srv/x", "/bin/zsh", false, false)).toBe(
      "cd '/srv/x'",
    );
  });
});
