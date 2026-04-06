/**
 * High-dim embedding -> 2D projection; pluggable projector interface.
 *
 * v1 uses stress majorization (classical MDS-style) with graph-theoretic
 * shortest-path distances as targets. The projector interface allows
 * future swap-in of UMAP, t-SNE, spectral, or learned embeddings.
 *
 * @module layout/manifold
 */

/**
 * @typedef {Object} Projector
 * @property {string} name
 * @property {function(Map<string, number[]>): Map<string, {x: number, y: number}>} project
 */

/**
 * Compute graph-theoretic distances via BFS from each node.
 * Returns a Map of nodeId -> Map<nodeId, distance>.
 *
 * @param {Map<string, import('../core/types.js').Node>} nodes
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @returns {Map<string, Map<string, number>>}
 */
export function graphDistances(nodes, edges) {
  // Build adjacency list
  const adj = new Map();
  for (const [id] of nodes) adj.set(id, []);
  for (const [, edge] of edges) {
    const sAdj = adj.get(edge.source);
    const tAdj = adj.get(edge.target);
    if (sAdj) sAdj.push(edge.target);
    if (tAdj) tAdj.push(edge.source);
  }

  const distances = new Map();
  for (const [startId] of nodes) {
    const dist = new Map();
    dist.set(startId, 0);
    const queue = [startId];
    let qi = 0;
    while (qi < queue.length) {
      const current = queue[qi++];
      const d = dist.get(current);
      const neighbors = adj.get(current) || [];
      for (const n of neighbors) {
        if (!dist.has(n)) {
          dist.set(n, d + 1);
          queue.push(n);
        }
      }
    }
    distances.set(startId, dist);
  }

  return distances;
}

/**
 * Classical MDS-style 2D projection using graph distances.
 * Uses iterative stress minimization.
 *
 * @param {Map<string, import('../core/types.js').Node>} nodes
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {Object} [options]
 * @param {number} [options.scale=100] - distance scale factor
 * @param {number} [options.iterations=50]
 * @returns {Map<string, { x: number, y: number }>}
 */
export function project(nodes, edges, options) {
  const scale = (options && options.scale) || 100;
  const iterations = (options && options.iterations) || 50;
  const nodeIds = [...nodes.keys()];
  const n = nodeIds.length;

  if (n === 0) return new Map();
  if (n === 1) return new Map([[nodeIds[0], { x: 0, y: 0 }]]);

  // Initialize positions in a circle
  const pos = new Map();
  const radius = scale * Math.sqrt(n) / 2;
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    pos.set(nodeIds[i], {
      x: radius * Math.cos(angle) + (Math.random() - 0.5) * 10,
      y: radius * Math.sin(angle) + (Math.random() - 0.5) * 10,
    });
  }

  // Compute target distances
  const graphDist = graphDistances(nodes, edges);

  // Stress majorization iterations
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < n; i++) {
      const id = nodeIds[i];
      const pi = pos.get(id);
      let wx = 0, wy = 0, wSum = 0;

      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const jd = nodeIds[j];
        const pj = pos.get(jd);

        const targetDist = (graphDist.get(id)?.get(jd) ?? n) * scale;
        const dx = pi.x - pj.x;
        const dy = pi.y - pj.y;
        const currentDist = Math.sqrt(dx * dx + dy * dy) || 0.001;

        const w = 1 / (targetDist * targetDist);
        wx += w * (pj.x + targetDist * dx / currentDist);
        wy += w * (pj.y + targetDist * dy / currentDist);
        wSum += w;
      }

      if (wSum > 0) {
        pi.x = wx / wSum;
        pi.y = wy / wSum;
      }
    }
  }

  return pos;
}
