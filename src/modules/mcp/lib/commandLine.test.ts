import { describe, expect, it } from "vitest";
import { joinCommandLine, splitCommandLine } from "./commandLine";

describe("splitCommandLine", () => {
  it("splits on whitespace", () => {
    expect(
      splitCommandLine("  npx -y   @modelcontextprotocol/server-everything "),
    ).toEqual(["npx", "-y", "@modelcontextprotocol/server-everything"]);
    expect(splitCommandLine("")).toEqual([]);
  });

  it("groups quoted words, keeping empty ones", () => {
    expect(splitCommandLine(`node "my server.js" '' --name 'a "b"'`)).toEqual([
      "node",
      "my server.js",
      "",
      "--name",
      'a "b"',
    ]);
    expect(splitCommandLine(`echo "say \\"hi\\" \\\\ now"`)).toEqual([
      "echo",
      'say "hi" \\ now',
    ]);
    expect(splitCommandLine(`--opt="a b"c`)).toEqual(["--opt=a bc"]);
  });

  it("leaves backslashes alone outside quotes, for Windows paths", () => {
    expect(splitCommandLine(`C:\\tools\\server.exe --dir C:\\data`)).toEqual([
      "C:\\tools\\server.exe",
      "--dir",
      "C:\\data",
    ]);
  });
});

describe("joinCommandLine", () => {
  it("round-trips through splitCommandLine", () => {
    for (const words of [
      ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/srv"],
      ["node", "my server.js", ""],
      ["echo", `it's "quoted"`, "a\\b c"],
      ["C:\\Program Files\\Server\\run.exe", "--x"],
    ]) {
      expect(splitCommandLine(joinCommandLine(words))).toEqual(words);
    }
  });

  it("quotes only what needs it", () => {
    expect(joinCommandLine(["uvx", "mcp-server-fetch"])).toBe(
      "uvx mcp-server-fetch",
    );
    expect(joinCommandLine(["a b"])).toBe("'a b'");
  });
});
