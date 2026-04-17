/**
 * Gather rule — the first moment/rule in the substrate.
 *
 * Payload shape:
 *   targetX, targetY: world coords to pull toward
 *   strength: pull factor per second (default 3.0)
 *
 * While live, each frame each member's position is nudged toward
 * (targetX, targetY) by a lerp whose step scales with dt and strength.
 * Locked members are skipped. Members already within 0.5px of the target
 * contribute zero (avoids jitter near convergence).
 *
 * This is the same math as the legacy updateGather() — re-expressed as a
 * rule so the substrate can carry it. The parity test asserts identical
 * trajectories.
 *
 * @module rules/gather
 */

export const gatherRule = {
  name: 'gather',

  tick(moment, ctx) {
    const { posMap, dt } = ctx;
    if (!posMap || !dt) return null;

    const strength = moment.payload.strength != null ? moment.payload.strength : 3.0;
    const t = Math.min(1, (strength * dt) / 1000);
    const { targetX, targetY } = moment.payload;
    if (targetX == null || targetY == null) return null;

    const posDeltas = new Map();
    for (const id of moment.members) {
      const ps = posMap.positions.get(id);
      if (!ps || ps.locked) continue;
      const dx = targetX - ps.x;
      const dy = targetY - ps.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      posDeltas.set(id, { dx: dx * t, dy: dy * t });
    }

    moment.elapsed += dt;
    return { posDeltas };
  },
};

/**
 * Compute the centroid of a set of node positions, or null if empty.
 * @param {Iterable<string>} memberIds
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {{x: number, y: number} | null}
 */
export function gatherCentroid(memberIds, posMap) {
  let cx = 0, cy = 0, n = 0;
  for (const id of memberIds) {
    const ps = posMap.positions.get(id);
    if (ps) { cx += ps.x; cy += ps.y; n++; }
  }
  if (n === 0) return null;
  return { x: cx / n, y: cy / n };
}

/**
 * Compute neighbors of a node excluding those already in `exclude`.
 * Used by the stranger-gather case (click + Space with no selection).
 * @param {string} anchorId
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {Set<string>} [exclude]
 * @returns {string[]}
 */
export function neighborsOf(anchorId, edges, exclude) {
  const out = new Set();
  const skip = exclude || new Set();
  for (const [, edge] of edges) {
    if (edge.source === anchorId && !skip.has(edge.target)) out.add(edge.target);
    if (edge.target === anchorId && !skip.has(edge.source)) out.add(edge.source);
  }
  return [...out];
}
