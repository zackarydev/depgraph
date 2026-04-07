/**
 * Z-key: moves the history cursor; supports branches.
 *
 * SPEC §10: "Z is TIME TRAVEL through the unified history."
 * - Hold Z: cursor steps backward continuously.
 * - Tap Z: one step back.
 * - Alt+Left/Right: step cursor by one event.
 * - Shift+Z: fast-reverse (larger stride).
 * - Release Z: cursor stays, new actions create a branch.
 *
 * Pure logic: operates on History, emits cursor-moved events.
 *
 * @module interact/time-travel
 */

import { stepCursor, moveCursor, effectiveRows, listBranches, switchBranch } from '../data/history.js';

/**
 * @typedef {Object} TimeTravelState
 * @property {boolean} active - whether Z is held
 * @property {boolean} fast - shift held = fast mode
 * @property {number} elapsed - ms since last step
 * @property {number} stepInterval - ms between auto-steps (decreases over time)
 * @property {number} direction - -1 = backward, +1 = forward
 */

/**
 * Begin time travel (Z pressed).
 * @param {boolean} [shiftHeld=false] - fast mode
 * @returns {TimeTravelState}
 */
export function startTimeTravel(shiftHeld = false) {
  return {
    active: true,
    fast: shiftHeld,
    elapsed: 0,
    stepInterval: shiftHeld ? 50 : 200,
    direction: -1,
  };
}

/**
 * Per-frame update: steps the cursor backward if enough time has elapsed.
 * Returns the delta applied (0 if no step this frame).
 *
 * @param {TimeTravelState} tt
 * @param {number} dt - ms since last frame
 * @param {import('../data/history.js').History} history
 * @returns {{ stepped: boolean, newCursor: number }}
 */
export function updateTimeTravel(tt, dt, history) {
  if (!tt.active) return { stepped: false, newCursor: history.cursor };

  tt.elapsed += dt;

  if (tt.elapsed >= tt.stepInterval) {
    tt.elapsed = 0;
    // Ramp up speed over time (min interval: 30ms)
    tt.stepInterval = Math.max(30, tt.stepInterval * 0.95);

    const stride = tt.fast ? 5 : 1;
    const newCursor = stepCursor(history, tt.direction * stride);
    return { stepped: true, newCursor };
  }

  return { stepped: false, newCursor: history.cursor };
}

/**
 * Stop time travel (Z released). Cursor stays where it is.
 * @param {TimeTravelState} tt
 */
export function stopTimeTravel(tt) {
  tt.active = false;
}

/**
 * Single step in a direction (Alt+Arrow).
 * @param {import('../data/history.js').History} history
 * @param {number} delta - +1 or -1
 * @returns {number} new cursor position
 */
export function stepOnce(history, delta) {
  return stepCursor(history, delta);
}

/**
 * Jump cursor to a specific position (e.g. click on timeline).
 * @param {import('../data/history.js').History} history
 * @param {number} position
 * @returns {number} new cursor position
 */
export function jumpTo(history, position) {
  return moveCursor(history, position);
}

/**
 * Navigate to the next or previous branch (Alt+Up/Down).
 * @param {import('../data/history.js').History} history
 * @param {number} direction - +1 = next branch, -1 = previous branch
 * @returns {boolean} true if switched
 */
export function switchBranchByDirection(history, direction) {
  const branches = listBranches(history);
  const currentIdx = branches.findIndex(b => b.id === history.activeBranch);
  const nextIdx = currentIdx + direction;

  if (nextIdx < 0 || nextIdx >= branches.length) return false;
  return switchBranch(history, branches[nextIdx].id);
}

/**
 * Get current time travel status for UI display.
 * @param {import('../data/history.js').History} history
 * @returns {{ cursor: number, total: number, branch: string, atEnd: boolean }}
 */
export function timeTravelStatus(history) {
  const eff = effectiveRows(history);
  return {
    cursor: history.cursor,
    total: eff.length,
    branch: history.activeBranch,
    atEnd: history.cursor >= eff.length - 1,
  };
}
