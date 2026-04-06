/**
 * Viewport culling: query spatial index for visible set + halo.
 *
 * Given a view rectangle (what the camera sees) and a halo margin,
 * returns the set of node IDs that should have DOM elements.
 * Everything outside is culled — no DOM node created.
 *
 * @module render/viewport
 */

/**
 * @typedef {Object} ViewBounds
 * @property {number} x - left edge in world coords
 * @property {number} y - top edge in world coords
 * @property {number} width
 * @property {number} height
 */

/**
 * Query all points within the view bounds + halo from a quadtree.
 * Returns an array of point objects (with id, x, y).
 *
 * @param {import('../layout/quadtree.js').QTNode} tree
 * @param {ViewBounds} bounds
 * @param {number} [halo=200] - extra margin in world coords
 * @returns {{ id: string, x: number, y: number }[]}
 */
export function queryVisible(tree, bounds, halo = 200) {
  const result = [];
  const minX = bounds.x - halo;
  const minY = bounds.y - halo;
  const maxX = bounds.x + bounds.width + halo;
  const maxY = bounds.y + bounds.height + halo;

  queryRect(tree, minX, minY, maxX, maxY, result);
  return result;
}

/**
 * Compute the screen radius of a node given zoom scale.
 * Used for LOD decisions (expand/collapse clusters).
 *
 * @param {number} worldRadius - the node's world-space radius
 * @param {number} zoom - current zoom scale factor
 * @returns {number} screen-space radius in pixels
 */
export function screenRadius(worldRadius, zoom) {
  return worldRadius * zoom;
}

/**
 * Determine LOD level from screen radius per SPEC §5.
 *
 * @param {number} radius - screen radius in px
 * @param {boolean} pinnedCollapsed - if true, always return 'dot'
 * @param {boolean} pinnedExpanded - if true, always return 'expanded'
 * @returns {'dot'|'circle'|'circle-meta'|'expanded'|'full'}
 */
export function lodLevel(radius, pinnedCollapsed, pinnedExpanded) {
  if (pinnedCollapsed) return 'dot';
  if (pinnedExpanded) return 'expanded';

  if (radius < 8) return 'dot';
  if (radius < 40) return 'circle';
  if (radius < 80) return 'circle-meta';
  if (radius < 200) return 'expanded';
  return 'full';
}

/**
 * Given a set of clusters + positions + zoom, decide which clusters
 * should be expanded (showing members) vs collapsed (single node).
 *
 * @param {Map<string, import('../core/types.js').Cluster>} clusters
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {number} zoom - current zoom scale
 * @param {import('../core/types.js').WorkingContext} context
 * @param {number} [budget=5000] - max visible primitives before refusing expansion
 * @returns {{ expanded: Set<string>, collapsed: Set<string> }}
 */
export function computeExpansion(clusters, posMap, zoom, context, budget = 5000) {
  const expanded = new Set();
  const collapsed = new Set();
  let totalVisible = 0;

  for (const [clusterId, cluster] of clusters) {
    // Estimate cluster world radius from member spread
    const radius = estimateClusterRadius(cluster, posMap);
    const sr = screenRadius(radius, zoom);

    const isPinnedCollapsed = context.pinnedClusters && context.pinnedClusters.has(clusterId);
    // Pin-expanded: check if cluster id (without prefix) is in pinnedClusters with expand marker
    // For v1: pinnedClusters = collapsed. We'll use focalNodes for expand hints.
    const isPinnedExpanded = false; // TODO: Phase 8 will add pin-expanded via context

    const lod = lodLevel(sr, isPinnedCollapsed, isPinnedExpanded);

    if (lod === 'expanded' || lod === 'full') {
      if (totalVisible + cluster.members.size <= budget) {
        expanded.add(clusterId);
        totalVisible += cluster.members.size;
      } else {
        collapsed.add(clusterId);
        totalVisible += 1;
      }
    } else {
      collapsed.add(clusterId);
      totalVisible += 1;
    }
  }

  return { expanded, collapsed };
}

// ─── Internal ───

function queryRect(node, minX, minY, maxX, maxY, result) {
  // Quick reject: if this quad doesn't overlap the rect
  const qMinX = node.cx - node.halfW;
  const qMinY = node.cy - node.halfH;
  const qMaxX = node.cx + node.halfW;
  const qMaxY = node.cy + node.halfH;

  if (qMaxX < minX || qMinX > maxX || qMaxY < minY || qMinY > maxY) return;

  if (node.children) {
    for (const child of node.children) {
      queryRect(child, minX, minY, maxX, maxY, result);
    }
  } else {
    for (const p of node.points) {
      if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
        result.push(p);
      }
    }
  }
}

function estimateClusterRadius(cluster, posMap) {
  if (!cluster.members || cluster.members.size === 0) return 0;

  let cx = 0, cy = 0, count = 0;
  for (const memberId of cluster.members) {
    const ps = posMap.positions.get(memberId);
    if (ps) { cx += ps.x; cy += ps.y; count++; }
  }
  if (count === 0) return 0;
  cx /= count;
  cy /= count;

  let maxDist = 0;
  for (const memberId of cluster.members) {
    const ps = posMap.positions.get(memberId);
    if (ps) {
      const d = Math.sqrt((ps.x - cx) ** 2 + (ps.y - cy) ** 2);
      if (d > maxDist) maxDist = d;
    }
  }

  return maxDist + 20; // padding
}
