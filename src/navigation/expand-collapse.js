/**
 * Cluster expand/collapse topology changes.
 *
 * Independent of zoom -- these are explicit user actions that override
 * the automatic screen-radius LOD. Pinning is stored in WorkingContext,
 * not on the cluster itself.
 *
 * SPEC S5: "Pinning is bidirectional: pin-collapsed (keep as node),
 * pin-expanded (keep open). Both are properties of the context."
 *
 * @module navigation/expand-collapse
 */

/**
 * Pin a cluster as expanded (always show members, never collapse).
 * Returns a new context with the pin applied.
 *
 * @param {string} clusterId
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {import('../core/types.js').WorkingContext}
 */
export function expandCluster(clusterId, context) {
  const newCollapsed = new Set(context.pinnedClusters);
  newCollapsed.delete(clusterId);
  const newExpanded = new Set(context.pinnedExpanded || new Set());
  newExpanded.add(clusterId);
  return {
    ...context,
    pinnedClusters: newCollapsed,
    pinnedExpanded: newExpanded,
  };
}

/**
 * Pin a cluster as collapsed (always render as single node, never expand).
 *
 * @param {string} clusterId
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {import('../core/types.js').WorkingContext}
 */
export function collapseCluster(clusterId, context) {
  const newCollapsed = new Set(context.pinnedClusters);
  newCollapsed.add(clusterId);
  const newExpanded = new Set(context.pinnedExpanded || new Set());
  newExpanded.delete(clusterId);
  return {
    ...context,
    pinnedClusters: newCollapsed,
    pinnedExpanded: newExpanded,
  };
}

/**
 * Toggle a cluster between pinned-collapsed, pinned-expanded, and auto.
 * Cycle: auto -> collapsed -> expanded -> auto
 *
 * @param {string} clusterId
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {import('../core/types.js').WorkingContext}
 */
export function toggleCollapse(clusterId, context) {
  const isCollapsed = context.pinnedClusters.has(clusterId);
  const isExpanded = context.pinnedExpanded && context.pinnedExpanded.has(clusterId);

  if (isCollapsed) {
    // collapsed -> expanded
    return expandCluster(clusterId, context);
  }
  if (isExpanded) {
    // expanded -> auto (remove both pins)
    const newExpanded = new Set(context.pinnedExpanded);
    newExpanded.delete(clusterId);
    return {
      ...context,
      pinnedExpanded: newExpanded,
    };
  }
  // auto -> collapsed
  return collapseCluster(clusterId, context);
}

/**
 * Check if a cluster is pinned collapsed.
 * @param {string} clusterId
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {boolean}
 */
export function isPinnedCollapsed(clusterId, context) {
  return context.pinnedClusters.has(clusterId);
}

/**
 * Check if a cluster is pinned expanded.
 * @param {string} clusterId
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {boolean}
 */
export function isPinnedExpanded(clusterId, context) {
  return !!(context.pinnedExpanded && context.pinnedExpanded.has(clusterId));
}
