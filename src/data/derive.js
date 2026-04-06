/**
 * Derivation engine: edges -> hyperedges -> affinities -> clusters.
 *
 * The derivative hierarchy (SPEC §3):
 *   d0 = Node, Edge (primitives)
 *   d1 = HyperEdge (equivalence class of edges sharing a member)
 *        Affinities (per-node distribution over groups, weighted by W)
 *   d2 = Cluster (promoted hyperedge -> node with memberOf edges)
 *
 * Dirty propagation: when an edge changes, only its endpoints' affinities
 * and their clusters are recomputed — not the entire graph.
 *
 * @module data/derive
 */

/** @typedef {import('../core/types.js').WeightVector} WeightVector */
/** @typedef {import('../core/types.js').HyperEdge} HyperEdge */
/** @typedef {import('../core/types.js').Cluster} Cluster */

/** Default weights used when no W provided. */
const FALLBACK_W = {
  calls: 0.3,
  calledBy: 0.2,
  memberOf: 5.0,
  shared: 0.5,
  sharedWrites: 0.5,
  sharedName: 1.5,
  spatial: 0.1,
};

/**
 * @typedef {Object} Derivation
 * @property {Map<string, HyperEdge>} hyperEdges
 * @property {Map<string, Map<string, number>>} affinities - nodeId -> Map<clusterId, weight>
 * @property {Map<string, Cluster>} clusters
 * @property {Set<string>} dirtyNodes - nodes needing affinity recomputation
 */

/**
 * Create an empty derivation state.
 * @returns {Derivation}
 */
export function createDerivation() {
  return {
    hyperEdges: new Map(),
    affinities: new Map(),
    clusters: new Map(),
    dirtyNodes: new Set(),
  };
}

/**
 * Derive hyperedges from the edge set.
 *
 * A hyperedge is an equivalence class of edges that share a common member
 * (node) on the same layer. For example, all `calls` edges touching node A
 * form one hyperedge.
 *
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @returns {Map<string, HyperEdge>}
 */
export function deriveHyperEdges(edges) {
  const hyperEdges = new Map();

  for (const [, edge] of edges) {
    // Each edge contributes to two hyperedges: one for source, one for target
    for (const member of [edge.source, edge.target]) {
      const heId = `${member}@${edge.layer}`;
      let he = hyperEdges.get(heId);
      if (!he) {
        he = {
          id: heId,
          layer: edge.layer,
          commonMember: member,
          edgeIds: new Set(),
        };
        hyperEdges.set(heId, he);
      }
      he.edgeIds.add(edge.id);
    }
  }

  return hyperEdges;
}

/**
 * Derive affinities for a single node.
 *
 * affinity(n, g) = SUM{ edge.weight * layerWeight(edge.layer) }
 *   for all edges incident on n, grouped by the "other" node's primary cluster.
 * Normalized so affinities sum to 1.
 *
 * When clusters don't exist yet (first pass), we group by the other endpoint
 * directly — each neighbor is its own group.
 *
 * @param {string} nodeId
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {WeightVector} [W]
 * @param {Map<string, string>} [nodeToCluster] - nodeId -> clusterId mapping
 * @returns {Map<string, number>} groupId -> weight (sums to 1)
 */
export function deriveAffinities(nodeId, edges, W, nodeToCluster) {
  const w = W || FALLBACK_W;
  const raw = new Map();

  for (const [, edge] of edges) {
    let other = null;
    if (edge.source === nodeId) other = edge.target;
    else if (edge.target === nodeId) other = edge.source;
    else continue;

    const layerWeight = w[edge.layer] != null ? w[edge.layer] : 1.0;
    const contribution = (edge.weight || 1) * layerWeight;

    // Group by cluster if available, otherwise by other node
    const groupId = nodeToCluster ? (nodeToCluster.get(other) || other) : other;

    raw.set(groupId, (raw.get(groupId) || 0) + contribution);
  }

  // Normalize
  let total = 0;
  for (const v of raw.values()) total += v;
  if (total > 0) {
    for (const [k, v] of raw) {
      raw.set(k, v / total);
    }
  }

  return raw;
}

/**
 * Derive clusters from nodes and their affinities.
 *
 * A cluster is a group of nodes that share the same primary affinity
 * (argmax of their affinity distribution). The cluster is promoted to
 * a node — this is the d1 -> d2 step.
 *
 * For the initial pass (no prior clusters), we use memberOf edges
 * to seed clusters. When memberOf edges exist, they define the grouping.
 * Otherwise, we use connected components via strongest affinity.
 *
 * @param {Map<string, import('../core/types.js').Node>} nodes
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {Map<string, Map<string, number>>} affinities - per-node affinity maps
 * @returns {Map<string, Cluster>}
 */
export function deriveClusters(nodes, edges, affinities) {
  const clusters = new Map();

  // First: use memberOf edges to form explicit clusters
  const memberOfTargets = new Set();
  for (const [, edge] of edges) {
    if (edge.layer === 'memberOf') {
      memberOfTargets.add(edge.target);
      const clusterId = `cluster:${edge.target}`;
      let cluster = clusters.get(clusterId);
      if (!cluster) {
        cluster = {
          id: clusterId,
          members: new Set(),
          sourceHyperEdge: `${edge.target}@memberOf`,
        };
        clusters.set(clusterId, cluster);
      }
      cluster.members.add(edge.source);
    }
  }

  // Second: for nodes not in any memberOf cluster, assign by primary affinity
  const clustered = new Set();
  for (const [, cluster] of clusters) {
    for (const m of cluster.members) clustered.add(m);
  }

  for (const [nodeId] of nodes) {
    if (clustered.has(nodeId)) continue;
    if (memberOfTargets.has(nodeId)) continue; // cluster-target nodes aren't members of themselves

    const aff = affinities.get(nodeId);
    if (!aff || aff.size === 0) continue;

    // Find primary affinity (argmax)
    let bestGroup = null;
    let bestWeight = -1;
    for (const [groupId, weight] of aff) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestGroup = groupId;
      }
    }

    if (bestGroup) {
      const clusterId = `cluster:${bestGroup}`;
      let cluster = clusters.get(clusterId);
      if (!cluster) {
        cluster = {
          id: clusterId,
          members: new Set(),
          sourceHyperEdge: `${bestGroup}@affinity`,
        };
        clusters.set(clusterId, cluster);
      }
      cluster.members.add(nodeId);
    }
  }

  return clusters;
}

/**
 * Build a nodeId -> clusterId lookup from clusters.
 * @param {Map<string, Cluster>} clusters
 * @returns {Map<string, string>}
 */
export function buildClusterIndex(clusters) {
  const index = new Map();
  for (const [clusterId, cluster] of clusters) {
    for (const member of cluster.members) {
      index.set(member, clusterId);
    }
  }
  return index;
}

/**
 * Run the full derivation pipeline: edges -> hyperEdges -> affinities -> clusters.
 *
 * @param {Map<string, import('../core/types.js').Node>} nodes
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {WeightVector} [W]
 * @returns {Derivation}
 */
export function deriveAll(nodes, edges, W) {
  const hyperEdges = deriveHyperEdges(edges);

  // First pass: affinities without cluster grouping
  const affinities = new Map();
  for (const [nodeId] of nodes) {
    affinities.set(nodeId, deriveAffinities(nodeId, edges, W));
  }

  // Derive clusters from first-pass affinities
  const clusters = deriveClusters(nodes, edges, affinities);

  // Second pass: re-derive affinities grouped by cluster
  const clusterIndex = buildClusterIndex(clusters);
  if (clusterIndex.size > 0) {
    for (const [nodeId] of nodes) {
      affinities.set(nodeId, deriveAffinities(nodeId, edges, W, clusterIndex));
    }
  }

  return {
    hyperEdges,
    affinities,
    clusters,
    dirtyNodes: new Set(),
  };
}

/**
 * Mark a node as dirty (needing affinity recomputation).
 * @param {Derivation} derivation
 * @param {string} nodeId
 */
export function invalidateNode(derivation, nodeId) {
  derivation.dirtyNodes.add(nodeId);
}

/**
 * Mark both endpoints of an edge as dirty.
 * @param {Derivation} derivation
 * @param {import('../core/types.js').HistoryRow} row - the edge row
 */
export function invalidateEdge(derivation, row) {
  if (row.source) derivation.dirtyNodes.add(row.source);
  if (row.target) derivation.dirtyNodes.add(row.target);
}

/**
 * Recompute only the dirty nodes' affinities and update clusters.
 * Clears the dirty set afterward.
 *
 * @param {Derivation} derivation
 * @param {Map<string, import('../core/types.js').Node>} nodes
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {WeightVector} [W]
 */
export function recompute(derivation, nodes, edges, W) {
  if (derivation.dirtyNodes.size === 0) return;

  // Rebuild hyperedges (cheap — full scan but no alloc-heavy ops)
  derivation.hyperEdges = deriveHyperEdges(edges);

  // Recompute affinities only for dirty nodes
  const clusterIndex = buildClusterIndex(derivation.clusters);
  for (const nodeId of derivation.dirtyNodes) {
    if (nodes.has(nodeId)) {
      derivation.affinities.set(
        nodeId,
        deriveAffinities(nodeId, edges, W, clusterIndex)
      );
    } else {
      derivation.affinities.delete(nodeId);
    }
  }

  // Re-derive clusters (uses updated affinities)
  derivation.clusters = deriveClusters(nodes, edges, derivation.affinities);

  derivation.dirtyNodes.clear();
}
