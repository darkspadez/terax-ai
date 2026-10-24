import "../styles/globals.css";

import { installNativeContextMenuGuard } from "@/lib/nativeContextMenu";
import { ThemeProvider } from "@/modules/theme";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { QuickTerminalApp } from "./QuickTerminalApp";

installNativeContextMenuGuard();

// Reap shells a previous load of this window left behind (this window's only).
await invoke("pty_close_all").catch(() => {});

ReactDOM.createRoot(
  document.getElementById("quick-root") as HTMLElement,
).render(
  <ThemeProvider>
    <QuickTerminalApp />
  </ThemeProvider>,
);

// Created hidden on the first hotkey press; shown once it has painted.
// setTimeout, not rAF: animation frames do not run while hidden.
setTimeout(() => {
  const window = getCurrentWindow();
  void window
    .show()
    .then(() => window.setFocus())
    .catch((error) => console.error("quick terminal show failed:", error));
}, 50);
