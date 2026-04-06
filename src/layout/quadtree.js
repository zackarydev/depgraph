/**
 * Barnes-Hut 2D spatial index.
 *
 * Provides O(N log N) approximate repulsion via center-of-mass
 * aggregation. Interface is octree-swappable for future 3D support.
 *
 * @module layout/quadtree
 */

/**
 * @typedef {Object} QTNode
 * @property {number} cx - center x of this quad
 * @property {number} cy - center y of this quad
 * @property {number} halfW - half width
 * @property {number} halfH - half height
 * @property {QTNode[]|null} children - 4 children (NW, NE, SW, SE) or null
 * @property {{ id: string, x: number, y: number }[]} points - points at this leaf
 * @property {number} totalMass - aggregated mass
 * @property {number} comX - center of mass x
 * @property {number} comY - center of mass y
 * @property {number} count - total points in subtree
 */

const MAX_POINTS_PER_LEAF = 4;
const MAX_DEPTH = 20;

/**
 * Create an empty quadtree covering the given bounds.
 * @param {number} [x=-5000]
 * @param {number} [y=-5000]
 * @param {number} [w=10000]
 * @param {number} [h=10000]
 * @returns {QTNode}
 */
export function createQuadtree(x = -5000, y = -5000, w = 10000, h = 10000) {
  return {
    cx: x + w / 2,
    cy: y + h / 2,
    halfW: w / 2,
    halfH: h / 2,
    children: null,
    points: [],
    totalMass: 0,
    comX: 0,
    comY: 0,
    count: 0,
  };
}

/**
 * Insert a point into the quadtree.
 * @param {QTNode} node
 * @param {{ id: string, x: number, y: number, mass?: number }} point
 * @param {number} [depth=0]
 */
export function insert(node, point, depth = 0) {
  const mass = point.mass || 1;

  // Update center of mass
  const newTotal = node.totalMass + mass;
  node.comX = (node.comX * node.totalMass + point.x * mass) / newTotal;
  node.comY = (node.comY * node.totalMass + point.y * mass) / newTotal;
  node.totalMass = newTotal;
  node.count++;

  // If this is a branch, recurse into child
  if (node.children) {
    const qi = quadrantIndex(node, point.x, point.y);
    insert(node.children[qi], point, depth + 1);
    return;
  }

  // Leaf: add point
  node.points.push(point);

  // Split if over capacity and not at max depth
  if (node.points.length > MAX_POINTS_PER_LEAF && depth < MAX_DEPTH) {
    subdivide(node, depth);
  }
}

/**
 * Remove a point by id. Returns true if found.
 * @param {QTNode} node
 * @param {string} id
 * @returns {boolean}
 */
export function remove(node, id) {
  if (node.children) {
    for (const child of node.children) {
      if (remove(child, id)) {
        recalcAggregate(node);
        return true;
      }
    }
    return false;
  }

  const idx = node.points.findIndex(p => p.id === id);
  if (idx === -1) return false;

  node.points.splice(idx, 1);
  recalcAggregate(node);
  return true;
}

/**
 * Rebuild the quadtree from a set of points.
 * @param {{ id: string, x: number, y: number, mass?: number }[]} points
 * @returns {QTNode}
 */
export function rebuild(points) {
  if (points.length === 0) return createQuadtree();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const pad = 100;
  const w = Math.max(maxX - minX + pad * 2, 1);
  const h = Math.max(maxY - minY + pad * 2, 1);
  const tree = createQuadtree(minX - pad, minY - pad, w, h);

  for (const p of points) {
    insert(tree, p);
  }

  return tree;
}

/**
 * Compute approximate repulsion force on a point using Barnes-Hut.
 * Returns {fx, fy} force vector.
 *
 * @param {QTNode} node
 * @param {{ x: number, y: number }} point
 * @param {number} [theta=0.7] - accuracy parameter (lower = more accurate)
 * @param {number} [repulsionK=1000] - repulsion strength
 * @returns {{ fx: number, fy: number }}
 */
export function approximateRepulsion(node, point, theta = 0.7, repulsionK = 1000) {
  if (node.count === 0) return { fx: 0, fy: 0 };

  const dx = node.comX - point.x;
  const dy = node.comY - point.y;
  const distSq = dx * dx + dy * dy;
  const dist = Math.sqrt(distSq) || 0.001;

  const size = node.halfW * 2;

  // If leaf or sufficiently far away, use aggregate
  if (!node.children || (size / dist) < theta) {
    if (distSq < 0.01) return { fx: 0, fy: 0 };
    // Coulomb-like repulsion: F = -k * mass / r^2
    const force = -repulsionK * node.totalMass / distSq;
    return { fx: force * dx / dist, fy: force * dy / dist };
  }

  // Otherwise recurse into children
  let fx = 0, fy = 0;
  for (const child of node.children) {
    const f = approximateRepulsion(child, point, theta, repulsionK);
    fx += f.fx;
    fy += f.fy;
  }
  return { fx, fy };
}

/**
 * Find k nearest neighbors to a probe point.
 * @param {QTNode} node
 * @param {{ x: number, y: number }} probe
 * @param {number} k
 * @returns {{ id: string, x: number, y: number, dist: number }[]}
 */
export function nearest(node, probe, k) {
  const candidates = [];
  collectAll(node, candidates);

  const withDist = candidates.map(p => ({
    ...p,
    dist: Math.sqrt((p.x - probe.x) ** 2 + (p.y - probe.y) ** 2),
  }));
  withDist.sort((a, b) => a.dist - b.dist);

  return withDist.slice(0, k);
}

// ─── Internal helpers ───

function quadrantIndex(node, x, y) {
  const isRight = x >= node.cx ? 1 : 0;
  const isBottom = y >= node.cy ? 1 : 0;
  return isBottom * 2 + isRight;
}

function subdivide(node, depth) {
  const hw = node.halfW / 2;
  const hh = node.halfH / 2;

  node.children = [
    createQuadtree(node.cx - node.halfW, node.cy - node.halfH, hw * 2, hh * 2), // NW
    createQuadtree(node.cx, node.cy - node.halfH, hw * 2, hh * 2),               // NE
    createQuadtree(node.cx - node.halfW, node.cy, hw * 2, hh * 2),               // SW
    createQuadtree(node.cx, node.cy, hw * 2, hh * 2),                             // SE
  ];

  const pts = node.points;
  node.points = [];
  for (const p of pts) {
    const qi = quadrantIndex(node, p.x, p.y);
    insert(node.children[qi], p, depth + 1);
  }
}

function recalcAggregate(node) {
  if (node.children) {
    node.totalMass = 0;
    node.comX = 0;
    node.comY = 0;
    node.count = 0;
    for (const child of node.children) {
      if (child.count > 0) {
        const newTotal = node.totalMass + child.totalMass;
        node.comX = (node.comX * node.totalMass + child.comX * child.totalMass) / (newTotal || 1);
        node.comY = (node.comY * node.totalMass + child.comY * child.totalMass) / (newTotal || 1);
        node.totalMass = newTotal;
        node.count += child.count;
      }
    }
  } else {
    node.totalMass = 0;
    node.comX = 0;
    node.comY = 0;
    node.count = node.points.length;
    for (const p of node.points) {
      const m = p.mass || 1;
      const newTotal = node.totalMass + m;
      node.comX = (node.comX * node.totalMass + p.x * m) / (newTotal || 1);
      node.comY = (node.comY * node.totalMass + p.y * m) / (newTotal || 1);
      node.totalMass = newTotal;
    }
  }
}

function collectAll(node, out) {
  if (node.children) {
    for (const child of node.children) collectAll(child, out);
  } else {
    for (const p of node.points) out.push(p);
  }
}
