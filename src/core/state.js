/**
 * Single State object; all mutations go through reducers.
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
 * @property {number} cursor
 * @property {WorkingContext} context
 */

/** Create an empty state. */
export function createState() {}

/** Apply a single history row to state, returning new state. */
export function applyRow(state, row) {}
