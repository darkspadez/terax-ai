import type { Theme } from "../types";

// Terminal colours are Ghostty's "Ayu Mirage" (iTerm2-Color-Schemes); chrome
// and selection from the ayu 8 palette (ayu-theme/ayu-colors). MIT, see
// NOTICE.txt.
export const ayuMirage: Theme = {
  id: "ayu-mirage",
  name: "Ayu Mirage",
  author: "Konstantin Pschera",
  description: "The softer, blue-grey Mirage variant of Ayu.",
  editorTheme: { dark: "tokyo-night" },
  variants: {
    dark: {
      colors: {
        background: "#1f2430",
        foreground: "#cccac2",
        card: "#1c212b",
        cardForeground: "#cccac2",
        popover: "#1c212b",
        popoverForeground: "#cccac2",
        primary: "#ffcc66",
        primaryForeground: "#1f2430",
        secondary: "#293040",
        secondaryForeground: "#cccac2",
        muted: "#293040",
        mutedForeground: "#8f908f",
        accent: "#293040",
        accentForeground: "#cccac2",
        destructive: "#ff6666",
        border: "rgba(204,202,194,0.08)",
        input: "rgba(204,202,194,0.12)",
        ring: "#ffcc66",
        sidebar: "#1c212b",
        sidebarForeground: "#cccac2",
        sidebarPrimary: "#ffcc66",
        sidebarPrimaryForeground: "#1f2430",
        sidebarAccent: "#293040",
        sidebarAccentForeground: "#cccac2",
        sidebarBorder: "rgba(204,202,194,0.08)",
        sidebarRing: "#ffcc66",
      },
      terminal: {
        cursor: "#ffcc66",
        cursorAccent: "#1f2430",
        selection: "rgba(64,159,255,0.25)",
        ansi: [
          "#171b24", "#ed8274", "#87d96c", "#facc6e",
          "#6dcbfa", "#dabafa", "#90e1c6", "#c7c7c7",
          "#686868", "#f28779", "#d5ff80", "#ffd173",
          "#73d0ff", "#dfbfff", "#95e6cb", "#ffffff",
        ],
      },
    },
  },
};
