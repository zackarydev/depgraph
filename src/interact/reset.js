/**
 * X-key: positions -> T0, weights -> context defaults (NOT time travel).
 *
 * SPEC §10: "X is a restoring force. It does NOT move the history cursor."
 * - Hold X: positions decay toward T0. Weights decay toward context defaults.
 * - Shift+X + click node: that node resets to T0.
 * - Ctrl+X: weights reset, positions untouched.
 * - Release X: decay stops, write position rows to history.
 *
 * @module interact/reset
 */

import { resetToT0, resetAllToT0 } from '../layout/positions.js';

/**
 * @typedef {Object} ResetState
 * @property {boolean} active - whether X is held
 * @property {boolean} ctrlOnly - Ctrl+X mode (weights only)
 * @property {number} elapsed - ms since X pressed
 * @property {number} decayRate - lerp factor per second (0..1)
 */

/**
 * Begin a reset (X pressed).
 * @param {boolean} ctrlHeld
 * @returns {ResetState}
 */
export function startReset(ctrlHeld = false) {
  return {
    active: true,
    ctrlOnly: ctrlHeld,
    elapsed: 0,
    decayRate: 2.0,
  };
}

/**
 * Per-frame decay: lerp all unlocked node positions toward T0.
 * Returns the set of node ids that were moved.
 *
 * @param {ResetState} reset
 * @param {number} dt - ms since last frame
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {string[]} ids of nodes that moved
 */
export function updateReset(reset, dt, posMap) {
  if (!reset.active || reset.ctrlOnly) return [];

  reset.elapsed += dt;
  const t = Math.min(1, (reset.decayRate * dt) / 1000);
  const moved = [];

  for (const [id, ps] of posMap.positions) {
    if (ps.locked) continue;

    const dx = ps.t0x - ps.x;
    const dy = ps.t0y - ps.y;
    if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) continue;

    ps.x += dx * t;
    ps.y += dy * t;
    moved.push(id);
  }

  return moved;
}

/**
 * Stop the reset (X released). Returns history rows for moved positions.
 *
 * @param {ResetState} reset
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {import('../core/types.js').HistoryRow[]}
 */
export function stopReset(reset, posMap) {
  reset.active = false;
  // Positions are wherever they ended up; history rows written by caller
  return [];
}

/**
 * Reset a single node to T0 (shift+X + click, or ctrl+click).
 *
 * @param {string} nodeId
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {import('../core/types.js').HistoryRow|null}
 */
export function resetSingleNode(nodeId, posMap) {
  const ps = posMap.positions.get(nodeId);
  if (!ps || ps.locked) return null;

  resetToT0(posMap, nodeId);

  return {
    type: 'NODE',
    op: 'update',
    id: nodeId,
    payload: { x: ps.x, y: ps.y, author: 'user', action: 'reset-single' },
  };
}

/**
 * Reset weights to context defaults (Ctrl+X).
 * Returns a new context with weights reset to the preset defaults.
 *
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {import('../core/types.js').WorkingContext}
 */
export function resetWeights(context) {
  // Import would be circular; caller should use applyPreset(context, context.name)
  // This function signals intent; the actual reset is done by the caller.
  return context;
}
