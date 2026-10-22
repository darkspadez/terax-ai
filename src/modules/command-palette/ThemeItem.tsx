import { CommandItem } from "@/components/ui/command";

type Props = {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly onSelect: () => void;
};

/**
 * A theme in the palette's theme list. The active one is marked by
 * `CommandItem`'s own tick (`data-checked`), so a row never carries two.
 */
export function ThemeItem({ id, name, active, onSelect }: Props) {
  return (
    <CommandItem
      value={`theme:${id}`}
      onSelect={onSelect}
      className="text-[12.5px]"
      data-checked={active}
    >
      <span className="truncate">{name}</span>
    </CommandItem>
  );
}
