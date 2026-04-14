/**
 * Spatial memory: a stack of position snapshots that Z walks backward through.
 *
 * Distinct from history/time-travel (which re-derives graph state from CSV
 * rows). This is purely visual — a memory of "where the layout was a moment
 * ago." Drag end, reset release, gather stop each push a new arrangement.
 * Z rewinds through them with eased lerps.
 *
 * Port of old_versions/index.html spatialMemory.arrangements + zLoop.
 *
 * @module interact/arrangements
 */

/**
 * @typedef {Object} Arrangement
 * @property {string} label - what created this snapshot (drag, reset, gather, ...)
 * @property {Map<string, {x: number, y: number}>} positions - frozen posMap
 * @property {number} t - wall-clock ms when pushed
 */

/**
 * @typedef {Object} ArrangementStack
 * @property {Arrangement[]} stack - chronological list
 * @property {number} cursor - index of the currently displayed arrangement
 */

/** @returns {ArrangementStack} */
export function createArrangementStack() {
  return { stack: [], cursor: -1 };
}

/**
 * Snapshot the current posMap and append as a new arrangement.
 * If cursor is not at the end (user rewound with Z then kept interacting),
 * forward history is trimmed — same branching semantics as undo stacks.
 *
 * @param {ArrangementStack} st
 * @param {string} label
 * @param {import('../layout/positions.js').PositionMap} posMap
 */
export function pushArrangement(st, label, posMap) {
  const m = new Map();
  for (const [id, ps] of posMap.positions) {
    m.set(id, { x: ps.x, y: ps.y });
  }
  st.stack.length = st.cursor + 1;
  st.stack.push({ label, positions: m, t: Date.now() });
  st.cursor = st.stack.length - 1;
}

/**
 * Apply an arrangement's positions back to posMap. Missing ids are left as-is
 * (a node born after the snapshot stays where it is rather than vanishing).
 *
 * @param {ArrangementStack} st
 * @param {number} idx
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {boolean} true if an arrangement was applied
 */
export function applyArrangement(st, idx, posMap) {
  const arr = st.stack[idx];
  if (!arr) return false;
  for (const [id, p] of arr.positions) {
    const ps = posMap.positions.get(id);
    if (ps) { ps.x = p.x; ps.y = p.y; }
  }
  return true;
}

/**
 * @typedef {Object} TravelState
 * @property {boolean} active
 * @property {number} elapsed - ms since last step
 * @property {number} stepMs - step duration (how long between jumps)
 * @property {'back'|'fwd'} direction
 */

/**
 * Start travelling backward through the arrangement stack. On start we snapshot
 * the CURRENT position as an implicit top-of-stack entry so release at the
 * original spot is cheap, and the user never "loses" their working layout.
 *
 * @param {ArrangementStack} st
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {'back'|'fwd'} direction
 * @param {number} [stepMs=600]
 * @returns {TravelState|null} null if no earlier arrangement exists
 */
export function startTravel(st, posMap, direction = 'back', stepMs = 600) {
  if (direction === 'back') {
    // Capture "where we are right now" so the user can always return to it.
    // Only if the tip of the stack isn't already identical to current state.
    pushArrangement(st, 'z-pending', posMap);
    if (st.cursor <= 0) return null;
    // Immediately step one back and apply — gives instant feedback on press.
    st.cursor -= 1;
    applyArrangement(st, st.cursor, posMap);
  } else {
    if (st.cursor >= st.stack.length - 1) return null;
    st.cursor += 1;
    applyArrangement(st, st.cursor, posMap);
  }
  return { active: true, elapsed: 0, stepMs, direction };
}

/**
 * Per-frame update: every `stepMs` the cursor advances one arrangement
 * in the travel direction, and posMap snaps to it. The render pump smooths
 * the snap into a lerp via displayPositions.
 *
 * @param {TravelState} travel
 * @param {number} dt - ms since last frame
 * @param {ArrangementStack} st
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {boolean} true if an arrangement was applied this frame
 */
export function updateTravel(travel, dt, st, posMap) {
  if (!travel.active) return false;
  travel.elapsed += dt;
  if (travel.elapsed < travel.stepMs) return false;
  travel.elapsed = 0;
  if (travel.direction === 'back' && st.cursor > 0) {
    st.cursor -= 1;
  } else if (travel.direction === 'fwd' && st.cursor < st.stack.length - 1) {
    st.cursor += 1;
  } else {
    return false;
  }
  applyArrangement(st, st.cursor, posMap);
  return true;
}

/**
 * Stop travel. If we landed anywhere other than the original snapshot we
 * pushed at start, push a fresh arrangement so the landing becomes the new tip.
 * This matches the old zLoop's final `pushArrangement('z-travel', [])`.
 *
 * @param {TravelState} travel
 * @param {ArrangementStack} st
 * @param {import('../layout/positions.js').PositionMap} posMap
 */
export function stopTravel(travel, st, posMap) {
  travel.active = false;
  const tip = st.stack[st.stack.length - 1];
  if (tip && tip.label === 'z-pending' && st.cursor < st.stack.length - 1) {
    // User rewound and stopped — drop the implicit pending snapshot and push
    // a real arrangement at the landing position.
    st.stack.pop();
    pushArrangement(st, 'z-travel', posMap);
  } else if (tip && tip.label === 'z-pending') {
    // Landed back at the pending snapshot; relabel it.
    tip.label = 'z-travel';
  }
}
