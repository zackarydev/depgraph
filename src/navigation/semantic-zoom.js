/**
 * Semantic zoom: maps zoom scale k to per-cluster LOD decisions.
 *
 * This is the state machine that decides what's expanded/collapsed
 * based on screen radius. It never touches the DOM — it produces
 * a LOD map that the render plan consumes.
 *
 * SPEC §5: "A cluster expands when its on-screen radius crosses a
 * threshold (80px). This is zoom-agnostic."
 *
 * @module navigation/semantic-zoom
 */

import { screenRadius, lodLevel } from '../render/viewport.js';

/**
 * @typedef {Object} LODEntry
 * @property {string} clusterId
 * @property {'dot'|'circle'|'circle-meta'|'expanded'|'full'} lod
 * @property {number} screenRadius
 * @property {number} worldRadius
 */

/**
 * Compute LOD for every cluster given a zoom level.
 *
 * @param {number} zoomK - current zoom scale factor
 * @param {Map<string, import('../core/types.js').Cluster>} clusters
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {Map<string, LODEntry>}
 */
export function computeLOD(zoomK, clusters, posMap, context) {
  const lodMap = new Map();

  for (const [cid, cluster] of clusters) {
    const wr = estimateWorldRadius(cluster, posMap);
    const sr = screenRadius(wr, zoomK);

    const pinCollapsed = context.pinnedClusters && context.pinnedClusters.has(cid);
    const pinExpanded = false; // Phase 8

    const lod = lodLevel(sr, pinCollapsed, pinExpanded);

    lodMap.set(cid, {
      clusterId: cid,
      lod,
      screenRadius: sr,
      worldRadius: wr,
    });
  }

  return lodMap;
}

/**
 * Given two LOD maps (prev, next), compute which clusters changed state.
 * Useful for animating transitions.
 *
 * @param {Map<string, LODEntry>} prev
 * @param {Map<string, LODEntry>} next
 * @returns {{ expanded: string[], collapsed: string[], unchanged: string[] }}
 */
export function lodDiff(prev, next) {
  const expanded = [];
  const collapsed = [];
  const unchanged = [];

  for (const [cid, entry] of next) {
    const prevEntry = prev.get(cid);
    const wasExpanded = prevEntry && (prevEntry.lod === 'expanded' || prevEntry.lod === 'full');
    const isExpanded = entry.lod === 'expanded' || entry.lod === 'full';

    if (!wasExpanded && isExpanded) expanded.push(cid);
    else if (wasExpanded && !isExpanded) collapsed.push(cid);
    else unchanged.push(cid);
  }

  return { expanded, collapsed, unchanged };
}

function estimateWorldRadius(cluster, posMap) {
  if (!cluster.members || cluster.members.size === 0) return 0;

  let cx = 0, cy = 0, count = 0;
  for (const id of cluster.members) {
    const ps = posMap.positions.get(id);
    if (ps) { cx += ps.x; cy += ps.y; count++; }
  }
  if (count === 0) return 0;
  cx /= count;
  cy /= count;

  let maxDist = 0;
  for (const id of cluster.members) {
    const ps = posMap.positions.get(id);
    if (ps) {
      const d = Math.sqrt((ps.x - cx) ** 2 + (ps.y - cy) ** 2);
      if (d > maxDist) maxDist = d;
    }
  }

  return maxDist + 20;
}
