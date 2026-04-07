/**
 * Fractal recursive rendering engine.
 *
 * SPEC §5: "one render routine draws the graph, and it calls itself
 * to draw the interior of any expanded cluster."
 *
 * renderGraph(nodes, edges, depth):
 *   for each node n in nodes:
 *     if n is a cluster and expanded and screenRadius > threshold:
 *       renderGraph(members(n), edgesWithin(n), depth+1)  // recurse
 *     else:
 *       drawNode(n)                                        // leaf
 *   drawEdges(edges)
 *
 * The same function, the same layer stack, the same physics at every
 * depth. Depgraph is a fractal.
 *
 * @module render/fractal
 */

import { screenRadius, lodLevel } from './viewport.js';
import { computeHull, expandHull } from './hulls.js';
import { clusterCentroid, computeMetaEdges } from './meta-edges.js';
import { buildClusterIndex } from '../data/derive.js';

/**
 * @typedef {Object} FractalNode
 * @property {string} id
 * @property {string} kind
 * @property {string} label
 * @property {number} importance
 * @property {number} depth - rendering depth
 * @property {boolean} isCluster
 * @property {string} [lod] - current LOD level
 * @property {[number,number][]} [hull] - expanded hull points (if expanded)
 */

/**
 * @typedef {Object} FractalEdge
 * @property {string} id
 * @property {string} source
 * @property {string} target
 * @property {string} layer
 * @property {number} weight
 * @property {number} depth
 * @property {boolean} isMeta - true if this is an aggregated meta-edge
 */

/**
 * @typedef {Object} RenderPlan
 * @property {FractalNode[]} nodes - all nodes to render (flat list, with depth)
 * @property {FractalEdge[]} edges - all edges to render (flat list, with depth)
 * @property {Array<{ clusterId: string, hull: [number,number][], depth: number }>} hulls
 * @property {Array<{ id: string, label: string, x: number, y: number, depth: number }>} clusterLabels
 * @property {number} maxDepth - deepest recursion reached
 * @property {number} totalPrimitives - total visible primitives
 */

/**
 * Compute the full render plan by recursively walking the cluster tree.
 *
 * This is the pure-logic core of fractal rendering. It produces a flat
 * plan of what to draw — the actual DOM manipulation happens in the
 * browser-specific renderers.
 *
 * @param {Object} params
 * @param {Map<string, import('../core/types.js').Node>} params.nodes
 * @param {Map<string, import('../core/types.js').Edge>} params.edges
 * @param {Map<string, import('../core/types.js').Cluster>} params.clusters
 * @param {import('../layout/positions.js').PositionMap} params.posMap
 * @param {import('../core/types.js').WorkingContext} params.context
 * @param {number} params.zoom - current zoom scale
 * @param {number} [params.budget=5000] - max visible primitives
 * @returns {RenderPlan}
 */
export function computeRenderPlan(params) {
  const { nodes, edges, clusters, posMap, context, zoom, budget = 5000 } = params;

  const plan = {
    nodes: [],
    edges: [],
    hulls: [],
    clusterLabels: [],
    maxDepth: 0,
    totalPrimitives: 0,
  };

  // Build cluster index: nodeId -> clusterId
  const clusterIndex = buildClusterIndex(clusters);

  // Build membership lookup: clusterId -> Set<nodeId>
  const clusterMembers = new Map();
  for (const [cid, cluster] of clusters) {
    clusterMembers.set(cid, cluster.members);
  }

  // Track which nodes are members of some cluster (they render inside their parent)
  const isMember = new Set();
  for (const [, cluster] of clusters) {
    for (const m of cluster.members) isMember.add(m);
  }

  // Start recursion from top-level nodes (not members of any cluster)
  const topNodes = new Map();
  for (const [id, node] of nodes) {
    if (!isMember.has(id)) {
      topNodes.set(id, node);
    }
  }

  // Also add cluster-as-nodes at the top level
  for (const [cid, cluster] of clusters) {
    // A cluster is a top-level renderable if its id isn't itself a member
    if (!isMember.has(cid)) {
      if (!topNodes.has(cid)) {
        topNodes.set(cid, {
          id: cid,
          kind: 'cluster',
          label: cid.replace('cluster:', ''),
          importance: cluster.members.size,
        });
      }
    }
  }

  renderGraphRecursive(
    topNodes, edges, clusters, clusterMembers, clusterIndex,
    posMap, context, zoom, 0, budget, plan
  );

  return plan;
}

/**
 * Recursive rendering function. SPEC §5 core algorithm.
 */
function renderGraphRecursive(
  nodesAtDepth, allEdges, clusters, clusterMembers,
  clusterIndex, posMap, context, zoom, depth, budget, plan
) {
  if (plan.totalPrimitives >= budget) return;
  if (depth > plan.maxDepth) plan.maxDepth = depth;

  const expandedClusters = new Set();
  const collapsedIds = new Set(); // cluster ids rendered as single nodes

  // Phase 1: decide which nodes to draw vs recurse into
  for (const [id, node] of nodesAtDepth) {
    if (plan.totalPrimitives >= budget) break;

    const cluster = clusters.get(id) || clusters.get(`cluster:${id}`);
    const isCluster = !!cluster;

    if (isCluster) {
      // Compute screen radius for LOD
      const worldRadius = estimateClusterWorldRadius(cluster, posMap);
      const sr = screenRadius(worldRadius, zoom);

      const isPinnedCollapsed = context.pinnedClusters && context.pinnedClusters.has(cluster.id);
      const isPinnedExpanded = false; // Phase 8 will add this

      const lod = lodLevel(sr, isPinnedCollapsed, isPinnedExpanded);

      if ((lod === 'expanded' || lod === 'full') &&
          plan.totalPrimitives + cluster.members.size <= budget) {
        // RECURSE: expand this cluster
        expandedClusters.add(cluster.id);

        // Compute hull
        const hull = computeHull(cluster, posMap);
        if (hull.length >= 3) {
          plan.hulls.push({
            clusterId: cluster.id,
            hull: expandHull(hull, 25),
            depth,
          });
        }

        // Cluster label at centroid
        const centroid = clusterCentroid(cluster, posMap);
        plan.clusterLabels.push({
          id: cluster.id,
          label: cluster.id.replace('cluster:', ''),
          x: centroid.x,
          y: centroid.y,
          depth,
        });

        // Build member node map for recursion
        const memberNodes = new Map();
        for (const memberId of cluster.members) {
          const memberNode = { id: memberId, kind: 'function', label: memberId, importance: 1 };
          // Try to get the real node data
          const allNodesMap = plan._allNodes; // not available here, use what we have
          memberNodes.set(memberId, memberNode);
        }

        // Recurse into this cluster's members
        renderGraphRecursive(
          memberNodes, allEdges, clusters, clusterMembers,
          clusterIndex, posMap, context, zoom, depth + 1, budget, plan
        );

      } else {
        // COLLAPSED: render as single node
        collapsedIds.add(cluster.id);
        const ps = posMap.positions.get(id);
        plan.nodes.push({
          id: cluster.id,
          kind: 'cluster',
          label: cluster.id.replace('cluster:', ''),
          importance: cluster.members.size,
          depth,
          isCluster: true,
          lod,
        });
        plan.totalPrimitives++;
      }
    } else {
      // Regular node — draw it
      plan.nodes.push({
        id,
        kind: node.kind || 'function',
        label: node.label || id,
        importance: node.importance || 1,
        depth,
        isCluster: false,
        lod: 'circle',
      });
      plan.totalPrimitives++;
    }
  }

  // Phase 2: collect edges at this depth
  const nodeIdsAtDepth = new Set(nodesAtDepth.keys());
  // Also include expanded cluster member ids
  for (const cid of expandedClusters) {
    const members = clusterMembers.get(cid);
    if (members) for (const m of members) nodeIdsAtDepth.add(m);
  }

  for (const [eid, edge] of allEdges) {
    // Only include edges where both endpoints are at this depth
    const srcHere = nodeIdsAtDepth.has(edge.source);
    const tgtHere = nodeIdsAtDepth.has(edge.target);

    if (srcHere && tgtHere) {
      plan.edges.push({
        id: eid,
        source: edge.source,
        target: edge.target,
        layer: edge.layer,
        weight: edge.weight,
        depth,
        isMeta: false,
      });
    }
  }

  // Phase 3: compute meta-edges between collapsed clusters at this depth
  if (collapsedIds.size >= 2) {
    // Build a temporary clusterIndex for nodes at this depth
    const localIndex = new Map();
    for (const cid of collapsedIds) {
      const members = clusterMembers.get(cid);
      if (members) {
        for (const m of members) localIndex.set(m, cid);
      }
    }
    const metaEdges = computeMetaEdges(allEdges, localIndex);
    for (const me of metaEdges) {
      plan.edges.push({
        id: `meta:${me.sourceCluster}|${me.targetCluster}`,
        source: me.sourceCluster,
        target: me.targetCluster,
        layer: me.layers[0] || 'meta',
        weight: me.weight,
        depth,
        isMeta: true,
      });
    }
  }
}

/**
 * Estimate a cluster's world-space radius from member positions.
 */
function estimateClusterWorldRadius(cluster, posMap) {
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

/**
 * Given a render plan, count primitives at each depth.
 * @param {RenderPlan} plan
 * @returns {Map<number, { nodes: number, edges: number, hulls: number }>}
 */
export function planStats(plan) {
  const stats = new Map();
  for (const n of plan.nodes) {
    if (!stats.has(n.depth)) stats.set(n.depth, { nodes: 0, edges: 0, hulls: 0 });
    stats.get(n.depth).nodes++;
  }
  for (const e of plan.edges) {
    if (!stats.has(e.depth)) stats.set(e.depth, { nodes: 0, edges: 0, hulls: 0 });
    stats.get(e.depth).edges++;
  }
  for (const h of plan.hulls) {
    if (!stats.has(h.depth)) stats.set(h.depth, { nodes: 0, edges: 0, hulls: 0 });
    stats.get(h.depth).hulls++;
  }
  return stats;
}
