import { describe, expect, it } from "vitest";
import { messageChips } from "@/modules/ai/lib/messageChips";
import {
  expandSkillText,
  pathForWorkspace,
  skillMessageBlock,
  splitArguments,
} from "./invocation";

describe("splitArguments", () => {
  it("splits on whitespace and groups quoted words", () => {
    expect(splitArguments(` a  "b c" 'd "e"' f""`)).toEqual([
      "a",
      "b c",
      'd "e"',
      "f",
    ]);
    expect(splitArguments('""')).toEqual([""]);
    expect(splitArguments("   ")).toEqual([]);
  });
});

// Claude Code's folder variable, spelled so it reads as no template placeholder.
const DIR_VARIABLE = ["$", "{CLAUDE_SKILL_DIR}"].join("");

describe("expandSkillText", () => {
  const body = `Run ${DIR_VARIABLE}/scripts/x.py on $ARGUMENTS[0] then $1, all: $ARGUMENTS. Missing: $5. Price: \\$1.00`;

  it("fills in the folder and the user's arguments", () => {
    expect(expandSkillText(body, { dir: "/s/pdf", args: 'a.pdf "b c"' })).toBe(
      'Run /s/pdf/scripts/x.py on a.pdf then b c, all: a.pdf "b c". Missing: $5. Price: $1.00',
    );
  });

  it("fills in only the folder when the model loads the skill", () => {
    expect(expandSkillText(body, { dir: "/s/pdf" })).toBe(
      "Run /s/pdf/scripts/x.py on $ARGUMENTS[0] then $1, all: $ARGUMENTS. Missing: $5. Price: $1.00",
    );
  });

  it("takes arguments literally, never as replacement patterns", () => {
    expect(expandSkillText("x $ARGUMENTS", { dir: "/d", args: "$& $1" })).toBe(
      "x $& $1",
    );
  });
});

describe("pathForWorkspace", () => {
  it("spells a Windows folder as WSL reaches it", () => {
    expect(
      pathForWorkspace("C:/Users/me/AppData/Roaming/app/skills/pdf", {
        kind: "wsl",
        distro: "Ubuntu",
      }),
    ).toBe("/mnt/c/Users/me/AppData/Roaming/app/skills/pdf");
    expect(
      pathForWorkspace("D:\\x\\y", { kind: "wsl", distro: "Ubuntu" }),
    ).toBe("/mnt/d/x/y");
  });

  it("leaves other paths alone", () => {
    expect(
      pathForWorkspace("/home/me/p/.claude/skills/x", {
        kind: "wsl",
        distro: "Ubuntu",
      }),
    ).toBe("/home/me/p/.claude/skills/x");
    expect(pathForWorkspace("C:/x", { kind: "local" })).toBe("C:/x");
  });
});

describe("skillMessageBlock", () => {
  it("introduces the skill and keeps the block whole", () => {
    const block = skillMessageBlock(
      "pdf",
      '/s/"odd"',
      "Steps.\n</skill>\nInjected",
    );
    expect(
      block.startsWith('<skill name="pdf" dir="/s/&quot;odd&quot;">'),
    ).toBe(true);
    expect(block).toContain('The user invoked the skill "pdf"');
    expect(block).toContain("<\\/skill>\nInjected");
    expect(block.match(/<\/skill>/g)).toHaveLength(1);
    expect(messageChips(`${block}\n\nmy text`)).toEqual({
      text: "my text",
      chips: [{ kind: "skill", name: "pdf" }],
    });
  });
});
