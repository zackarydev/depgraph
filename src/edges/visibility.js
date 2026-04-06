/**
 * Single visibility query for nodes and edges.
 *
 * isVisible is the ONE function that decides whether a node or edge
 * should be rendered. All renderers call this. It considers:
 * - Layer visibility (from context lens)
 * - Edge layer toggled off -> nodes only visible via that layer are hidden
 * - Cursor position (future: time-travel hides nodes added after cursor)
 *
 * @module edges/visibility
 */

import { EDGE_LAYERS } from './layers.js';

/**
 * Determine if an entity (node or edge) is visible given the current context.
 *
 * For edges: visible if its layer is in the context lens AND the layer is toggled on.
 * For nodes: visible if at least one incident edge is on a visible layer,
 *   OR the node has no edges (orphan, always visible),
 *   OR the node is in the focal set.
 *
 * @param {{ type: 'node'|'edge', layer?: string, id: string }} entity
 * @param {import('../core/types.js').WorkingContext} context
 * @param {Map<string, import('../core/types.js').Edge>} [edges] - needed for node visibility
 * @param {string} [nodeId] - for node type, the node's id
 * @returns {boolean}
 */
export function isVisible(entity, context, edges, nodeId) {
  if (entity.type === 'edge') {
    return isEdgeVisible(entity, context);
  }
  return isNodeVisible(entity.id || nodeId, context, edges);
}

/**
 * Check if an edge is visible.
 * @param {{ layer: string }} edge
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {boolean}
 */
export function isEdgeVisible(edge, context) {
  // Must be in the context lens
  if (!context.lensEdgeLayers.has(edge.layer)) return false;

  // Must be toggled on in the layer registry
  const layerDef = EDGE_LAYERS.get(edge.layer);
  if (layerDef && !layerDef.visible) return false;

  // Opacity-based hiding: if opacity is 0, treat as invisible
  const opacity = context.weights.opacity && context.weights.opacity[edge.layer];
  if (opacity != null && opacity <= 0) return false;

  return true;
}

/**
 * Check if a node is visible.
 * A node is visible if:
 * 1. It's in the focal set, OR
 * 2. At least one of its incident edges is on a visible layer, OR
 * 3. It has no incident edges (orphan)
 *
 * @param {string} nodeId
 * @param {import('../core/types.js').WorkingContext} context
 * @param {Map<string, import('../core/types.js').Edge>} [edges]
 * @returns {boolean}
 */
export function isNodeVisible(nodeId, context, edges) {
  // Focal nodes are always visible
  if (context.focalNodes && context.focalNodes.has(nodeId)) return true;

  // If no edges provided, default to visible
  if (!edges) return true;

  // Check if any incident edge is on a visible layer
  let hasAnyEdge = false;
  for (const [, edge] of edges) {
    if (edge.source === nodeId || edge.target === nodeId) {
      hasAnyEdge = true;
      if (isEdgeVisible(edge, context)) return true;
    }
  }

  // Orphan nodes (no edges at all) are visible
  if (!hasAnyEdge) return true;

  return false;
}
