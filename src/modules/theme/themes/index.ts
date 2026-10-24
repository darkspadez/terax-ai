import { DEFAULT_THEME_ID, type Theme } from "../types";
import { ayu } from "./ayu";
import { ayuMirage } from "./ayu-mirage";
import { caffeine } from "./caffeine";
import { catppuccin } from "./catppuccin";
import { claude } from "./claude";
import { dracula } from "./dracula";
import { everforest } from "./everforest";
import { flexoki } from "./flexoki";
import { github } from "./github";
import { gruvbox } from "./gruvbox";
import { kanagawa } from "./kanagawa";
import { kanagawaDragon } from "./kanagawa-dragon";
import { nightOwl } from "./night-owl";
import { nord } from "./nord";
import { oneHalf } from "./one-half";
import { rosePine } from "./rose-pine";
import { sage } from "./sage";
import { solarized } from "./solarized";
import { oarlockDefault } from "./oarlock-default";
import { tide } from "./tide";
import { tokyoNight } from "./tokyo-night";
import { tomorrow } from "./tomorrow";
import { xcode } from "./xcode";

const BUILTIN: Theme[] = [
  oarlockDefault,
  xcode,
  claude,
  kanagawa,
  kanagawaDragon,
  tokyoNight,
  catppuccin,
  rosePine,
  everforest,
  nord,
  gruvbox,
  dracula,
  solarized,
  github,
  oneHalf,
  ayu,
  ayuMirage,
  nightOwl,
  tomorrow,
  flexoki,
  tide,
  sage,
  caffeine,
];

const BY_ID = new Map<string, Theme>(BUILTIN.map((t) => [t.id, t]));

export function listBuiltinThemes(): Theme[] {
  return BUILTIN;
}

export function getBuiltinTheme(id: string): Theme | undefined {
  return BY_ID.get(id);
}

export function getDefaultTheme(): Theme {
  return BY_ID.get(DEFAULT_THEME_ID) ?? BUILTIN[0];
}
