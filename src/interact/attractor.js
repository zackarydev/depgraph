/**
 * Force-press / shift-hold pull: ramps attraction strength and
 * BFS depth by hold duration.
 *
 * The attractor is a temporary energy term that pulls neighbors
 * toward a focal node. The longer you hold, the stronger and deeper
 * the pull. On release, pulled nodes become auto-locked.
 *
 * @module interact/attractor
 */

import { updatePosition, setLocked } from '../layout/positions.js';

/**
 * @typedef {Object} AttractorState
 * @property {boolean} active
 * @property {string} focalId - the node being force-pressed
 * @property {number} elapsed - ms held
 * @property {number} strength - current pull strength (ramps up)
 * @property {number} maxDepth - BFS depth reached so far
 * @property {Map<string, number>} pulled - nodeId -> BFS depth at which it was pulled
 */

/**
 * Start an attractor from a focal node.
 * Discovers neighbors at BFS depth 1 initially.
 *
 * @param {string} focalId
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {AttractorState|null}
 */
export function startAttractor(focalId, edges, posMap) {
  const ps = posMap.positions.get(focalId);
  if (!ps) return null;

  const neighbors = bfsNeighbors(focalId, edges, 1);

  return {
    active: true,
    focalId,
    elapsed: 0,
    strength: 1.0,
    maxDepth: 1,
    pulled: neighbors,
  };
}

/**
 * BFS from a source node up to a given depth.
 * Returns Map<nodeId, depth>.
 *
 * @param {string} sourceId
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {number} maxDepth
 * @returns {Map<string, number>}
 */
export function bfsNeighbors(sourceId, edges, maxDepth) {
  const visited = new Map();
  visited.set(sourceId, 0);

  let frontier = [sourceId];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier = [];
    for (const nodeId of frontier) {
      for (const [, edge] of edges) {
        let neighbor = null;
        if (edge.source === nodeId) neighbor = edge.target;
        else if (edge.target === nodeId) neighbor = edge.source;

        if (neighbor && !visited.has(neighbor)) {
          visited.set(neighbor, depth);
          nextFrontier.push(neighbor);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  // Remove source from pulled set
  visited.delete(sourceId);
  return visited;
}

/**
 * Per-frame update: pull neighbors toward focal node.
 * Ramps strength and depth over time.
 *
 * @param {AttractorState} att
 * @param {number} dt - ms since last frame
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {string[]} ids that moved
 */
export function updateAttractor(att, dt, edges, posMap) {
  if (!att.active) return [];

  att.elapsed += dt;

  // Ramp up strength: starts at 1, maxes at 5 over 2 seconds
  att.strength = Math.min(5.0, 1.0 + (att.elapsed / 500));

  // Expand BFS depth every 800ms
  const newDepth = Math.min(6, 1 + Math.floor(att.elapsed / 800));
  if (newDepth > att.maxDepth) {
    att.maxDepth = newDepth;
    const expanded = bfsNeighbors(att.focalId, edges, newDepth);
    for (const [id, depth] of expanded) {
      if (!att.pulled.has(id)) att.pulled.set(id, depth);
    }
  }

  const focal = posMap.positions.get(att.focalId);
  if (!focal) return [];

  const t = Math.min(1, (att.strength * dt) / 1000);
  const moved = [];

  for (const [id, depth] of att.pulled) {
    const ps = posMap.positions.get(id);
    if (!ps || ps.locked) continue;

    // Strength falls off with BFS depth
    const depthFactor = 1 / depth;
    const dx = focal.x - ps.x;
    const dy = focal.y - ps.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

    ps.x += dx * t * depthFactor;
    ps.y += dy * t * depthFactor;
    moved.push(id);
  }

  return moved;
}

/**
 * Stop the attractor. Auto-locks pulled nodes.
 * Returns the set of nodes that were pulled (for history writing).
 *
 * @param {AttractorState} att
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {string[]} ids of pulled nodes
 */
export function stopAttractor(att, posMap) {
  att.active = false;

  const pulledIds = [];
  for (const [id] of att.pulled) {
    setLocked(posMap, id, true);
    pulledIds.push(id);
  }

  return pulledIds;
}
