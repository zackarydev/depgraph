/**
 * History rows -> live graph with derived structures.
 *
 * GraphBuilder wraps the raw state (nodes + edges maps from state.js)
 * and layers the derivation engine on top. It tracks which nodes are
 * dirty after edge mutations and supports incremental recomputation.
 *
 * @module data/graph-builder
 */

import { applyRow, createState } from '../core/state.js';
import {
  deriveAll,
  invalidateEdge,
  recompute,
} from './derive.js';
import { notifyRow, resetProperties } from '../core/properties.js';

/**
 * @typedef {Object} Graph
 * @property {import('../core/state.js').State} state - raw nodes + edges
 * @property {import('./derive.js').Derivation} derivation - hyperedges, affinities, clusters
 * @property {import('../core/properties.js').PropertyRegistry} [properties] - optional system-property listeners
 */

/**
 * Build a full graph from history rows + weight vector.
 * Replays all rows, then runs full derivation.
 *
 * @param {import('../core/types.js').HistoryRow[]} rows
 * @param {import('../core/types.js').WeightVector} [W]
 * @param {import('../core/properties.js').PropertyRegistry} [properties]
 * @returns {Graph}
 */
export function buildFromHistory(rows, W, properties) {
  const state = createState();
  resetProperties(properties);
  for (const row of rows) {
    applyRow(state, row);
    notifyRow(properties, row, state);
  }
  const derivation = deriveAll(state.nodes, state.edges, W);
  return { state, derivation, properties };
}

/**
 * Apply a single row to an existing graph, incrementally updating derivation.
 *
 * @param {Graph} graph
 * @param {import('../core/types.js').HistoryRow} row
 * @param {import('../core/types.js').WeightVector} [W]
 * @returns {Graph} the same graph object, mutated
 */
export function applyRowToGraph(graph, row, W) {
  applyRow(graph.state, row);
  if (graph.properties) notifyRow(graph.properties, row, graph.state);

  if (row.type === 'EDGE') {
    // Mark endpoints dirty for incremental recompute
    invalidateEdge(graph.derivation, row);
    recompute(graph.derivation, graph.state.nodes, graph.state.edges, W);
  } else if (row.type === 'NODE' && row.op === 'remove') {
    // Removing a node — full rederive (edges referencing it may be gone)
    graph.derivation = deriveAll(graph.state.nodes, graph.state.edges, W);
  }

  return graph;
}

/**
 * Rebuild derivation from scratch (e.g., after weight vector change).
 *
 * @param {Graph} graph
 * @param {import('../core/types.js').WeightVector} [W]
 * @returns {Graph} the same graph object, mutated
 */
export function rederive(graph, W) {
  graph.derivation = deriveAll(graph.state.nodes, graph.state.edges, W);
  return graph;
}
