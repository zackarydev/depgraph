/**
 * Meta-edges: aggregate primitive edges between clusters.
 *
 * A meta-edge at depth d is the aggregate of all primitive edges
 * whose endpoints live inside two different clusters. No separate
 * data structure — meta-edges are a group-by query.
 *
 * Also owns clusterCentroid() — single implementation used everywhere.
 *
 * @module render/meta-edges
 */

/**
 * @typedef {Object} MetaEdge
 * @property {string} sourceCluster
 * @property {string} targetCluster
 * @property {number} weight - sum of constituent edge weights
 * @property {number} count - number of constituent edges
 * @property {string[]} layers - distinct layers involved
 */

/**
 * Compute the centroid of a cluster from its member positions.
 * Single implementation — used by hulls, meta-edges, labels.
 *
 * @param {import('../core/types.js').Cluster} cluster
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {{ x: number, y: number }}
 */
export function clusterCentroid(cluster, posMap) {
  let cx = 0, cy = 0, count = 0;
  for (const memberId of cluster.members) {
    const ps = posMap.positions.get(memberId);
    if (ps) {
      cx += ps.x;
      cy += ps.y;
      count++;
    }
  }
  if (count === 0) return { x: 0, y: 0 };
  return { x: cx / count, y: cy / count };
}

/**
 * Compute meta-edges between clusters.
 *
 * For each primitive edge whose endpoints are in different clusters,
 * aggregate into a meta-edge keyed by (sourceCluster, targetCluster).
 *
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {Map<string, string>} nodeToCluster - nodeId -> clusterId
 * @returns {MetaEdge[]}
 */
export function computeMetaEdges(edges, nodeToCluster) {
  const agg = new Map(); // "clusterA|clusterB" -> MetaEdge

  for (const [, edge] of edges) {
    const sc = nodeToCluster.get(edge.source);
    const tc = nodeToCluster.get(edge.target);

    // Only create meta-edge for cross-cluster edges
    if (!sc || !tc || sc === tc) continue;

    // Canonical key (sorted to avoid duplicates)
    const key = sc < tc ? `${sc}|${tc}` : `${tc}|${sc}`;
    let me = agg.get(key);
    if (!me) {
      me = {
        sourceCluster: sc < tc ? sc : tc,
        targetCluster: sc < tc ? tc : sc,
        weight: 0,
        count: 0,
        layers: [],
      };
      agg.set(key, me);
    }

    me.weight += edge.weight || 1;
    me.count++;
    if (!me.layers.includes(edge.layer)) {
      me.layers.push(edge.layer);
    }
  }

  return [...agg.values()];
}

/**
 * Render meta-edges (SVG). Browser-only — no-op in Node.
 * Phase 5 wires this to the actual SVG layer.
 *
 * @param {*} gMetaLinks - SVG group element
 * @param {MetaEdge[]} metaEdges
 * @param {Map<string, import('../core/types.js').Cluster>} clusters
 * @param {import('../layout/positions.js').PositionMap} posMap
 */
export function renderMetaEdges(gMetaLinks, metaEdges, clusters, posMap) {
  if (!gMetaLinks || typeof document === 'undefined') return;

  // D3 data join will be wired here when D3 is available
  // For now, this is a placeholder for the browser render path
}
