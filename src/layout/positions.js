/**
 * Unified PositionState: {x, y, sticky, locked, t0} per node.
 *
 * Single source of truth for all node positions. Sticky dampens
 * gradient descent; locked zeroes it. T0 is the rest/initial position
 * used by X-reset.
 *
 * @module layout/positions
 */

/** @typedef {import('../core/types.js').PositionState} PositionState */

/**
 * @typedef {Object} PositionMap
 * @property {Map<string, PositionState>} positions - nodeId -> PositionState
 */

/**
 * Create a PositionMap (container for all node positions).
 * @returns {PositionMap}
 */
export function createPositionMap() {
  return { positions: new Map() };
}

/**
 * Create a single PositionState for a node.
 * @param {number} x
 * @param {number} y
 * @returns {PositionState}
 */
export function createPositionState(x, y) {
  return {
    x,
    y,
    t0x: x,
    t0y: y,
    sticky: false,
    locked: false,
    mass: 1,
  };
}

/**
 * Set or update a node's position in the map.
 * If the node doesn't exist yet, creates a new PositionState.
 * @param {PositionMap} posMap
 * @param {string} nodeId
 * @param {number} x
 * @param {number} y
 * @returns {PositionState}
 */
export function updatePosition(posMap, nodeId, x, y) {
  let ps = posMap.positions.get(nodeId);
  if (!ps) {
    ps = createPositionState(x, y);
    posMap.positions.set(nodeId, ps);
  } else {
    ps.x = x;
    ps.y = y;
  }
  return ps;
}

/**
 * Ensure a node has a position. If not, seed it at (x, y).
 * @param {PositionMap} posMap
 * @param {string} nodeId
 * @param {number} x
 * @param {number} y
 * @returns {PositionState}
 */
export function ensurePosition(posMap, nodeId, x, y) {
  let ps = posMap.positions.get(nodeId);
  if (!ps) {
    ps = createPositionState(x, y);
    posMap.positions.set(nodeId, ps);
  }
  return ps;
}

/**
 * Set sticky flag on a node.
 * @param {PositionMap} posMap
 * @param {string} nodeId
 * @param {boolean} sticky
 */
export function setSticky(posMap, nodeId, sticky) {
  const ps = posMap.positions.get(nodeId);
  if (ps) ps.sticky = sticky;
}

/**
 * Set mass for a node. Higher mass = less per-frame displacement under the
 * same accumulated forces. Structural nodes get mass ~1000 so the runtime
 * value-nodes (mass ~1) can flow through a near-rigid scaffold. See
 * RUNTIME_RULES.md (Inertia).
 * @param {PositionMap} posMap
 * @param {string} nodeId
 * @param {number} mass
 */
export function setMass(posMap, nodeId, mass) {
  const ps = posMap.positions.get(nodeId);
  if (ps) ps.mass = mass;
}

/**
 * Set locked flag on a node.
 * @param {PositionMap} posMap
 * @param {string} nodeId
 * @param {boolean} locked
 */
export function setLocked(posMap, nodeId, locked) {
  const ps = posMap.positions.get(nodeId);
  if (ps) ps.locked = locked;
}

/**
 * Reset a node's position to its T0 (initial/rest) values.
 * @param {PositionMap} posMap
 * @param {string} nodeId
 */
export function resetToT0(posMap, nodeId) {
  const ps = posMap.positions.get(nodeId);
  if (ps) {
    ps.x = ps.t0x;
    ps.y = ps.t0y;
  }
}

/**
 * Reset all positions to T0.
 * @param {PositionMap} posMap
 */
export function resetAllToT0(posMap) {
  for (const [, ps] of posMap.positions) {
    ps.x = ps.t0x;
    ps.y = ps.t0y;
  }
}

/**
 * Remove a node from the position map.
 * @param {PositionMap} posMap
 * @param {string} nodeId
 */
export function removePosition(posMap, nodeId) {
  posMap.positions.delete(nodeId);
}

/**
 * Get all positions as an array of {id, x, y} for quadtree building.
 * @param {PositionMap} posMap
 * @returns {{ id: string, x: number, y: number }[]}
 */
export function toPointArray(posMap) {
  const pts = [];
  for (const [id, ps] of posMap.positions) {
    pts.push({ id, x: ps.x, y: ps.y });
  }
  return pts;
}
