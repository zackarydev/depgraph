/**
 * Cluster expand/collapse topology changes.
 *
 * Independent of zoom — these are explicit user actions that override
 * the automatic screen-radius LOD. Pinning is stored in WorkingContext,
 * not on the cluster itself.
 *
 * SPEC §5: "Pinning is bidirectional: pin-collapsed (keep as node),
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
  const newPinned = new Set(context.pinnedClusters);
  newPinned.delete(clusterId); // remove collapse pin if present
  // For v1, we track expanded pins in focalNodes (a set the context already has).
  // Phase 8 will add a dedicated pinnedExpanded set.
  return {
    ...context,
    pinnedClusters: newPinned,
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
  const newPinned = new Set(context.pinnedClusters);
  newPinned.add(clusterId);
  return {
    ...context,
    pinnedClusters: newPinned,
  };
}

/**
 * Toggle a cluster between pinned-collapsed and auto (unpinned).
 *
 * @param {string} clusterId
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {import('../core/types.js').WorkingContext}
 */
export function toggleCollapse(clusterId, context) {
  if (context.pinnedClusters.has(clusterId)) {
    return expandCluster(clusterId, context);
  }
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
