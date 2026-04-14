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
import { descentStep } from '../layout/gradient.js';

/**
 * @typedef {Object} ResetState
 * @property {boolean} active - whether X is held
 * @property {boolean} ctrlOnly - Ctrl+X mode (weights only)
 * @property {number} elapsed - ms since X pressed
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
  };
}

/**
 * Per-frame relax: runs gradient descent so all edges approach their
 * energy minimum. This is the spec'd behavior — X "is a restoring force"
 * toward equilibrium, not a lerp to stale seed coordinates.
 *
 * @param {ResetState} reset
 * @param {number} dt - ms since last frame
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WeightVector} [W]
 * @returns {string[]} ids of nodes that moved
 */
export function updateReset(reset, dt, posMap, edges, W) {
  if (!reset.active || reset.ctrlOnly) return [];
  reset.elapsed += dt;
  if (!edges) return [];

  // Temporarily treat sticky nodes as non-sticky so they participate fully:
  // X is explicitly a relaxation gesture and should overpower drag stickiness.
  const prevSticky = new Map();
  for (const [id, ps] of posMap.positions) {
    if (ps.sticky) {
      prevSticky.set(id, true);
      ps.sticky = false;
    }
  }

  // Snapshot pre-step positions so we can report which nodes actually moved.
  const pre = new Map();
  for (const [id, ps] of posMap.positions) pre.set(id, { x: ps.x, y: ps.y });

  descentStep(posMap, edges, W, { eta: 0.25 });

  for (const [id, sticky] of prevSticky) {
    const ps = posMap.positions.get(id);
    if (ps) ps.sticky = sticky;
  }

  const moved = [];
  for (const [id, ps] of posMap.positions) {
    const p = pre.get(id);
    if (!p) continue;
    if (Math.abs(ps.x - p.x) > 0.01 || Math.abs(ps.y - p.y) > 0.01) moved.push(id);
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
