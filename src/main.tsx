import "./styles/globals.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir, isOpenedNow } from "./lib/launchDir";
import { installNativeContextMenuGuard } from "./lib/nativeContextMenu";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { installWindowFrame } from "./lib/windowFrame";
import { terminalDiagnosticsEnabled } from "@/modules/terminal/lib/terminalDiagnosticsEnabled";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}
installNativeContextMenuGuard();
installWindowFrame();

// Render-instrumentation overlay, opt-in: `VITE_REACT_SCAN=true bun run dev`.
// Dev-only dynamic import so it never reaches the production bundle.
if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN === "true") {
  const { scan } = await import("react-scan");
  scan({ enabled: true });
}

// Real-application benchmark (scripts/app-lab): scenario flags must be in force before any
// terminal module reads them. Removed entirely unless the build sets OARLOCK_BENCH=1.
if (__OARLOCK_BENCH__) {
  const { installBenchEarly } = await import("@/bench/early");
  await installBenchEarly();
}

// Reap PTY sessions orphaned by a prior webview load before any tab spawns.
await invoke("pty_close_all").catch(() => {});

// Seed before first paint so default tab mounts at target cwd (no flicker).
await initLaunchDir();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout — rAF is throttled
// while the window is hidden and would never fire.
// A window opened just now (a later launch from Explorer, Finder or a shell
// included) comes to the front; showing alone leaves it behind on macOS.
const focusOnShow = isOpenedNow();
const showWindow = () => {
  const current = getCurrentWindow();
  current
    .show()
    .then(() => (focusOnShow ? current.setFocus() : undefined))
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);

if (terminalDiagnosticsEnabled()) {
  void import("@/modules/terminal/lib/terminalDiagnostics").then(
    (diagnostics) => diagnostics.installTerminalDiagnostics(),
  );
}
