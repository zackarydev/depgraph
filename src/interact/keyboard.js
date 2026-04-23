/**
 * Central dispatch; routes by pointer-depth for fractal interaction.
 *
 * SPEC §5: "Every interaction operates at the depth the user is pointing
 * at." The keyboard dispatcher reads pointer depth and routes to the
 * local engine.
 *
 * This module is a pure state machine that maps key events to
 * interaction mode transitions. It does not listen to DOM events
 * directly — the browser layer calls these functions.
 *
 * @module interact/keyboard
 */

/**
 * @typedef {Object} KeyState
 * @property {Set<string>} held - currently held keys (lowercase)
 * @property {string|null} activeMode - the interaction mode currently owning position mutations
 * @property {number} pointerDepth - fractal depth at the pointer (0 = top level)
 */

/**
 * Interaction modes — only one may mutate positions per frame.
 * Trace and semantic-zoom are read-only overlays and run concurrently.
 */
const POSITION_MODES = new Set([
  'drag', 'reset', 'time-travel', 'gather', 'attractor', 'arrangement-travel',
]);

const OVERLAY_MODES = new Set([
  'trace',
]);

/**
 * Create a fresh key state.
 * @returns {KeyState}
 */
export function createKeyState(recorderState) {
  return {
    r: recorderState,
    held: new Set(),
    activeMode: null,
    pointerDepth: 0,
  };
}

/**
 * Process a keydown event and return the action to take.
 *
 * @param {KeyState} state
 * @param {string} key - lowercase key name
 * @param {{ shift: boolean, ctrl: boolean, alt: boolean }} modifiers
 * @returns {{ action: string, [key: string]: any } | null}
 */
export function keyDown(state, key, modifiers = {}) {
  state.held.add(key);

  const { shift = false, ctrl = false, alt = false } = modifiers;

  // X-key: reset (only if no position mode active)
  if (key === 'x' && !POSITION_MODES.has(state.activeMode)) {
    state.activeMode = 'reset';
    return { action: 'reset-start', ctrl, shift };
  }

  // Z-key: walk backward through the arrangement stack (spatial memory).
  // Distinct from history time-travel which lives on Alt+Arrow.
  if (key === 'z' && !POSITION_MODES.has(state.activeMode)) {
    state.activeMode = 'arrangement-travel';
    return { action: 'arrangement-back-start', shift };
  }

  // Space: gather (various modes)
  if (key === ' ' && !POSITION_MODES.has(state.activeMode)) {
    state.activeMode = 'gather';
    return { action: 'gather-start', shift };
  }

  // T-key: trace (overlay, can coexist)
  if (key === 't' && !state.held.has('t')) {
    return { action: 'trace-start' };
  }

  // B during trace: backward
  if (key === 'b' && state.held.has('t')) {
    return { action: 'trace-direction', direction: 'backward' };
  }

  // F during trace: forward
  if (key === 'f' && state.held.has('t')) {
    return { action: 'trace-direction', direction: 'forward' };
  }

  // H during trace: hold
  if (key === 'h') {
    return { action: 'trace-hold' };
  }

  // Escape: clear
  if (key === 'escape') {
    const prev = state.activeMode;
    state.activeMode = null;
    return { action: 'escape', previousMode: prev };
  }

  // Enter: create user cluster
  if (key === 'enter') {
    return { action: 'create-cluster' };
  }

  // Alt+Arrow: time step
  if (alt && key === 'arrowleft') {
    return { action: 'time-step', delta: -1 };
  }
  if (alt && key === 'arrowright') {
    return { action: 'time-step', delta: 1 };
  }
  if (alt && key === 'arrowup') {
    return { action: 'branch-switch', delta: -1 };
  }
  if (alt && key === 'arrowdown') {
    return { action: 'branch-switch', delta: 1 };
  }

  if(key === 'm') {
    if(!state.r.running) {
      state.r.recorder.start();
      state.r.running = true;
    } else {
      state.r.recorder.stop();
      state.r.running = false;
    }
    
  }

  return null;
}

/**
 * Process a keyup event and return the action to take.
 *
 * @param {KeyState} state
 * @param {string} key - lowercase key name
 * @returns {{ action: string, [key: string]: any } | null}
 */
export function keyUp(state, key) {
  state.held.delete(key);

  if (key === 'x' && state.activeMode === 'reset') {
    state.activeMode = null;
    return { action: 'reset-stop' };
  }

  if (key === 'z' && state.activeMode === 'arrangement-travel') {
    state.activeMode = null;
    return { action: 'arrangement-back-stop' };
  }

  if (key === ' ' && state.activeMode === 'gather') {
    state.activeMode = null;
    return { action: 'gather-stop' };
  }

  if (key === 't') {
    return { action: 'trace-release' };
  }

  // B/F release during trace: pause direction
  if (key === 'b' || key === 'f') {
    return { action: 'trace-direction-release', key };
  }

  return null;
}

/**
 * Set the pointer depth (fractal level the cursor is hovering over).
 * @param {KeyState} state
 * @param {number} depth
 */
export function setPointerDepth(state, depth) {
  state.pointerDepth = depth;
}

/**
 * Check if a position-mutating mode is active.
 * @param {KeyState} state
 * @returns {boolean}
 */
export function isPositionModeBusy(state) {
  return POSITION_MODES.has(state.activeMode);
}

/**
 * Force-clear the active mode (e.g. on blur/focus-loss).
 * @param {KeyState} state
 */
export function clearActiveMode(state) {
  state.activeMode = null;
  state.held.clear();
}
