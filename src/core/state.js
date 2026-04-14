/**
 * Single State object; all mutations go through reducers.
 *
 * State holds the two primitives (nodes, edges) and the cursor position.
 * Context is stored separately (core/context.js) but referenced here.
 *
 * @module core/state
 */

/** @typedef {import('./types.js').Node} Node */
/** @typedef {import('./types.js').Edge} Edge */
/** @typedef {import('./types.js').HistoryRow} HistoryRow */
/** @typedef {import('./types.js').WorkingContext} WorkingContext */

/**
 * @typedef {Object} State
 * @property {Map<string, Node>} nodes
 * @property {Map<string, Edge>} edges
 * @property {number} cursor - index of the last applied row
 */

/** Create an empty state. */
export function createState() {
  return {
    nodes: new Map(),
    edges: new Map(),
    cursor: -1,
  };
}

/**
 * Apply a single history row to state, mutating in place. Returns the state.
 *
 * This is the only function that modifies nodes/edges maps.
 * It handles NODE and EDGE rows with add/update/remove ops.
 *
 * @param {State} state
 * @param {HistoryRow} row
 * @returns {State}
 */
export function applyRow(state, row) {
  const { type, op, id } = row;

  if (type === 'NODE') {
    if (op === 'add') {
      state.nodes.set(id, {
        id,
        kind: row.kind || 'unknown',
        label: row.label || id,
        importance: row.weight != null ? row.weight : 1,
        payload: row.payload || null,
      });
    } else if (op === 'update') {
      const existing = state.nodes.get(id);
      if (existing) {
        if (row.kind != null) existing.kind = row.kind;
        if (row.label != null) existing.label = row.label;
        if (row.weight != null) existing.importance = row.weight;
        if (row.payload != null) {
          existing.payload = existing.payload
            ? { ...existing.payload, ...row.payload }
            : row.payload;
        }
      }
    } else if (op === 'remove') {
      state.nodes.delete(id);
    }
  } else if (type === 'EDGE') {
    if (op === 'add') {
      state.edges.set(id, {
        id,
        source: row.source,
        target: row.target,
        layer: row.layer || 'unknown',
        weight: row.weight != null ? row.weight : 1,
        stretch: row.payload?.stretch != null ? row.payload.stretch : 0,
        directed: row.payload?.directed !== false,
        label: row.label || null,
      });
    } else if (op === 'update') {
      const existing = state.edges.get(id);
      if (existing) {
        if (row.weight != null) existing.weight = row.weight;
        if (row.layer != null) existing.layer = row.layer;
        if (row.label != null) existing.label = row.label;
        if (row.source != null) existing.source = row.source;
        if (row.target != null) existing.target = row.target;
        if (row.payload != null) {
          if (row.payload.directed != null) existing.directed = row.payload.directed;
          if (row.payload.stretch != null) existing.stretch = row.payload.stretch;
        }
      }
    } else if (op === 'remove') {
      state.edges.delete(id);
    }
  }

  state.cursor = row.t;
  return state;
}

/**
 * Replay an array of history rows onto a fresh state.
 * @param {HistoryRow[]} rows
 * @returns {State}
 */
export function replayRows(rows) {
  const state = createState();
  for (const row of rows) {
    applyRow(state, row);
  }
  return state;
}
