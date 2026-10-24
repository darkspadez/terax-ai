import { Command, CommandGroup, CommandList } from "@/components/ui/command";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeItem } from "./ThemeItem";

function row(active: boolean): string {
  return renderToStaticMarkup(
    <Command>
      <CommandList>
        <CommandGroup>
          <ThemeItem
            id="dracula"
            name="Dracula"
            active={active}
            onSelect={() => {}}
          />
        </CommandGroup>
      </CommandList>
    </Command>,
  );
}

const ticks = (html: string) => (html.match(/<svg/g) ?? []).length;

describe("ThemeItem", () => {
  it("marks the active theme with the item's one tick", () => {
    const html = row(true);
    expect(ticks(html)).toBe(1);
    expect(html).toContain('data-checked="true"');
  });

  it("keeps the tick hidden on other themes", () => {
    const html = row(false);
    expect(ticks(html)).toBe(1);
    expect(html).toContain('data-checked="false"');
  });
});
