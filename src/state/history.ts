// Undo/redo history — a pure snapshot stack, independent of Svelte and audio.
//
// The project is updated immutably (spread copies with structural sharing;
// decoded audio lives in the engine and is referenced by id), so keeping whole
// `Project` snapshots is cheap. Continuous controls (faders, knobs) fire an
// edit per pointer move, which would bury the user's real steps under hundreds
// of micro-steps. Pushes therefore carry a `key`: consecutive pushes with the
// same key inside `coalesceMs` collapse into the first one, so a fader drag
// undoes as a single step while two separate drags stay separate.

export interface History<T> {
  readonly undoStack: readonly T[];
  readonly redoStack: readonly T[];
  readonly lastKey: string | null;
  readonly lastAt: number;
}

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 800;

export function createHistory<T>(): History<T> {
  return { undoStack: [], redoStack: [], lastKey: null, lastAt: -Infinity };
}

/** Record `snapshot` (the state *before* an edit). Any edit clears redo. */
export function push<T>(
  h: History<T>,
  snapshot: T,
  key: string | null = null,
  now = 0,
  coalesceMs = COALESCE_MS,
): History<T> {
  const coalesce = key !== null && key === h.lastKey && now - h.lastAt <= coalesceMs;
  if (coalesce) {
    // Same control still being dragged: keep the pre-drag snapshot, just
    // extend the window and drop any redo state the edit invalidates.
    return { ...h, redoStack: [], lastAt: now };
  }
  const undoStack = [...h.undoStack, snapshot].slice(-HISTORY_LIMIT);
  return { undoStack, redoStack: [], lastKey: key, lastAt: now };
}

/** Step back. `current` is the live state, which becomes redoable. */
export function undo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (h.undoStack.length === 0) return null;
  const state = h.undoStack[h.undoStack.length - 1];
  return {
    history: {
      undoStack: h.undoStack.slice(0, -1),
      redoStack: [...h.redoStack, current],
      lastKey: null,
      lastAt: -Infinity,
    },
    state,
  };
}

export function redo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (h.redoStack.length === 0) return null;
  const state = h.redoStack[h.redoStack.length - 1];
  return {
    history: {
      undoStack: [...h.undoStack, current],
      redoStack: h.redoStack.slice(0, -1),
      lastKey: null,
      lastAt: -Infinity,
    },
    state,
  };
}

export const canUndo = <T>(h: History<T>): boolean => h.undoStack.length > 0;
export const canRedo = <T>(h: History<T>): boolean => h.redoStack.length > 0;
