export {
  subscribeAgentSignals,
  useAgentActivityStore,
} from "./lib/agentActivity";
export {
  findLeafCwd,
  hasLeaf,
  leafIds,
  type PaneBounds,
  type PaneNode,
} from "./lib/panes";
export {
  clearFocusedTerminal,
  disposeSession,
  leafHasForegroundProcess,
  leafIdForPty,
  adjustFocusedTerminalFont,
  focusedTerminalInAlternateScreen,
  navigateFocusedBlocks,
  ptyIdForLeaf,
  scrollFocusedTerminal,
  whenSessionReady,
  writeToSession,
} from "./lib/terminalSessionApi";
export {
  selectTerminalTabStatus,
  type TerminalProgress,
  type TerminalTabStatus,
  useTerminalStatusStore,
} from "./lib/terminalStatus";
export { equalizePanes, resizeActivePane } from "./lib/paneLayout";
export { setTerminalFileOpener } from "./lib/terminalLinkOpen";
export { startWindowProgress } from "./lib/windowProgress";
export { isTerminalSurfaceTarget } from "./lib/terminalSurfaceTarget";
export { TerminalPromptDialog } from "./TerminalPromptDialog";
export {
  type TerminalPathDropTarget,
  useTerminalFileDrop,
} from "./lib/useTerminalFileDrop";
export type { TerminalPaneHandle } from "./TerminalPane";
export { TerminalStack } from "./TerminalStack";
