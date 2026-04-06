/**
 * Snapshot writing / loading for fast history resume.
 *
 * A snapshot captures the derived State (nodes + edges maps) at a
 * specific cursor position. Loading = latest snapshot + replaying
 * only the tail rows after it. This avoids full replay on large histories.
 *
 * See SPEC.md §13 (Scale to Infinity) for the scaling rationale.
 *
 * @module data/snapshot
 */

import { createState, applyRow } from '../core/state.js';

/**
 * Write a snapshot of the current state at a given cursor.
 *
 * @param {import('../core/state.js').State} state
 * @param {number} cursor
 * @returns {string} JSON string
 */
export function writeSnapshot(state, cursor) {
  const nodes = [];
  for (const [, node] of state.nodes) {
    nodes.push({ ...node });
  }

  const edges = [];
  for (const [, edge] of state.edges) {
    edges.push({ ...edge });
  }

  return JSON.stringify({
    version: 1,
    cursor,
    nodes,
    edges,
  });
}

/**
 * Load a snapshot from JSON, returning a State and cursor.
 *
 * @param {string} json
 * @returns {{ state: import('../core/state.js').State, cursor: number }}
 */
export function loadSnapshot(json) {
  const data = JSON.parse(json);
  const state = createState();

  for (const node of data.nodes) {
    state.nodes.set(node.id, node);
  }
  for (const edge of data.edges) {
    state.edges.set(edge.id, edge);
  }
  state.cursor = data.cursor;

  return { state, cursor: data.cursor };
}

/**
 * Load a snapshot and then replay tail rows on top of it.
 * This is the fast-load path: snapshot at cursor N + rows N+1..M
 * equals full replay of rows 0..M.
 *
 * @param {string} snapshotJson
 * @param {import('../core/types.js').HistoryRow[]} tailRows - rows after the snapshot cursor
 * @returns {{ state: import('../core/state.js').State, cursor: number }}
 */
export function loadWithTail(snapshotJson, tailRows) {
  const { state, cursor } = loadSnapshot(snapshotJson);

  for (const row of tailRows) {
    applyRow(state, row);
  }

  return {
    state,
    cursor: tailRows.length > 0 ? state.cursor : cursor,
  };
}
