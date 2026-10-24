export {
  subscribeAgentSignals,
  useAgentActivityStore,
} from "./lib/agentActivity";
export {
  canSplitPane,
  findLeafCwd,
  hasLeaf,
  leafIds,
  type PaneBounds,
  type PaneNode,
  type SplitPosition,
} from "./lib/panes";
export {
  clearFocusedTerminal,
  disposeSession,
  leafHasForegroundProcess,
  leafIdForPty,
  leafShellAtPrompt,
  adjustFocusedTerminalFont,
  focusedTerminalInAlternateScreen,
  navigateFocusedBlocks,
  ptyIdForLeaf,
  restartSession,
  scrollFocusedTerminal,
  whenSessionReady,
  writeToSession,
} from "./lib/terminalSessionApi";
export {
  selectTerminalTabStatus,
  type TerminalLeafStatus,
  type TerminalProgress,
  useTerminalStatusStore,
} from "./lib/terminalStatus";
export { equalizePanes, resizeActivePane } from "./lib/paneLayout";
export {
  setTerminalFileOpener,
  setTerminalPreviewOpener,
} from "./lib/terminalLinkOpen";
export { startWindowProgress } from "./lib/windowProgress";
export { isTerminalSurfaceTarget } from "./lib/terminalSurfaceTarget";
export { TerminalPromptDialog } from "./TerminalPromptDialog";
export { useTerminalFileDrop } from "./lib/useTerminalFileDrop";
export type { TerminalPaneHandle } from "./TerminalPane";
export { TerminalStack } from "./TerminalStack";
