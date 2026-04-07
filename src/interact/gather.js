/**
 * Neighbor / cluster / intra-cluster / space-pull (one engine).
 *
 * SPEC §10 + controls.md:
 * - Hold Space (2+ selected): pull selected toward their centroid
 * - Click node + Space: pull unselected neighbors toward clicked node
 * - Click node + Shift+Space: pull selected toward clicked node
 * - Click cluster label + Space: pull connected clusters toward clicked cluster
 * - Click cluster label + Shift+Space: pull cluster members toward centroid
 *
 * All modes are the same function with different targets and node sets.
 * Locked nodes are never affected.
 *
 * @module interact/gather
 */

import { updatePosition } from '../layout/positions.js';

/**
 * @typedef {Object} GatherState
 * @property {boolean} active
 * @property {'centroid'|'node'|'cluster'} mode
 * @property {number} targetX - world x to pull toward
 * @property {number} targetY - world y to pull toward
 * @property {Set<string>} pulledIds - nodes being pulled
 * @property {number} strength - pull factor per second
 * @property {number} elapsed
 */

/**
 * Compute the centroid of a set of node positions.
 * @param {Set<string>} nodeIds
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {{x: number, y: number}}
 */
export function centroid(nodeIds, posMap) {
  let cx = 0, cy = 0, count = 0;
  for (const id of nodeIds) {
    const ps = posMap.positions.get(id);
    if (ps) { cx += ps.x; cy += ps.y; count++; }
  }
  if (count === 0) return { x: 0, y: 0 };
  return { x: cx / count, y: cy / count };
}

/**
 * Start a gather: pull selected nodes toward their centroid.
 * (Hold Space with 2+ selected nodes)
 *
 * @param {import('./select.js').SelectionState} selection
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {GatherState|null} null if fewer than 2 selected
 */
export function startGather(selection, posMap) {
  if (selection.selected.size < 2) return null;

  const c = centroid(selection.selected, posMap);
  return {
    active: true,
    mode: 'centroid',
    targetX: c.x,
    targetY: c.y,
    pulledIds: new Set(selection.selected),
    strength: 3.0,
    elapsed: 0,
  };
}

/**
 * Start a stranger gather: pull unselected neighbors toward a clicked node.
 * (Click node + Space)
 *
 * @param {string} anchorId - the clicked node
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('./select.js').SelectionState} selection
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {GatherState|null}
 */
export function startStrangerGather(anchorId, edges, selection, posMap) {
  const ps = posMap.positions.get(anchorId);
  if (!ps) return null;

  // Find neighbors of anchor not in selection
  const neighbors = new Set();
  for (const [, edge] of edges) {
    if (edge.source === anchorId && !selection.selected.has(edge.target)) {
      neighbors.add(edge.target);
    }
    if (edge.target === anchorId && !selection.selected.has(edge.source)) {
      neighbors.add(edge.source);
    }
  }

  if (neighbors.size === 0) return null;

  return {
    active: true,
    mode: 'node',
    targetX: ps.x,
    targetY: ps.y,
    pulledIds: neighbors,
    strength: 3.0,
    elapsed: 0,
  };
}

/**
 * Start a group gather: pull selected nodes toward a clicked node.
 * (Click node + Shift+Space with 2+ selected)
 *
 * @param {string} anchorId - the clicked node to pull toward
 * @param {import('./select.js').SelectionState} selection
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {GatherState|null}
 */
export function startGroupGather(anchorId, selection, posMap) {
  const ps = posMap.positions.get(anchorId);
  if (!ps || selection.selected.size < 2) return null;

  // Pull all selected except the anchor
  const pulled = new Set(selection.selected);
  pulled.delete(anchorId);

  return {
    active: true,
    mode: 'node',
    targetX: ps.x,
    targetY: ps.y,
    pulledIds: pulled,
    strength: 3.0,
    elapsed: 0,
  };
}

/**
 * Start a cluster gather: pull cluster members toward cluster centroid.
 * (Click cluster label + Shift+Space)
 *
 * @param {import('../core/types.js').Cluster} cluster
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {GatherState|null}
 */
export function startClusterGather(cluster, posMap) {
  if (!cluster.members || cluster.members.size < 2) return null;

  const c = centroid(cluster.members, posMap);
  return {
    active: true,
    mode: 'cluster',
    targetX: c.x,
    targetY: c.y,
    pulledIds: new Set(cluster.members),
    strength: 3.0,
    elapsed: 0,
  };
}

/**
 * Per-frame update: lerp pulled nodes toward the target.
 * Returns the set of ids that moved this frame.
 *
 * @param {GatherState} gather
 * @param {number} dt - ms since last frame
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {string[]} ids that moved
 */
export function updateGather(gather, dt, posMap) {
  if (!gather.active) return [];

  gather.elapsed += dt;
  const t = Math.min(1, (gather.strength * dt) / 1000);
  const moved = [];

  for (const id of gather.pulledIds) {
    const ps = posMap.positions.get(id);
    if (!ps || ps.locked) continue;

    const dx = gather.targetX - ps.x;
    const dy = gather.targetY - ps.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

    ps.x += dx * t;
    ps.y += dy * t;
    moved.push(id);
  }

  return moved;
}

/**
 * Stop gathering. Caller writes history rows for moved positions.
 * @param {GatherState} gather
 */
export function stopGather(gather) {
  gather.active = false;
}
