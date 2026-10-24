type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Layout moved the terminal area without resizing it (the sidebar changed
 * sides). Size observers do not fire for a move, so renderers that place
 * themselves on the device pixel grid are told directly.
 */
export function notifyTerminalAreaMoved(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeTerminalAreaMoved(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
