/**
 * Energy function E + gradient descent step.
 *
 * E = SUM_edges w_layer * (||x_s - x_t|| - d_target)^2   (attraction)
 *   + SUM_pairs repulsion(||x_i - x_j||)                  (collision)
 *   + SUM_pinned k_pin * ||x - x_pinned||^2               (anchors)
 *
 * Per frame: x <- x - eta * gradE(x)
 *
 * Sticky nodes: eta *= STICKY_DAMPEN
 * Locked nodes: eta = 0
 *
 * @module layout/gradient
 */

import { rebuild, approximateRepulsion } from './quadtree.js';
import { toPointArray } from './positions.js';

const DEFAULT_ETA = 0.1;
const STICKY_DAMPEN = 0.05;
const DEFAULT_TARGET_DIST = 100;
const PIN_K = 0.1;
const REPULSION_K = 500;
const BH_THETA = 0.7;
const MAX_DISPLACEMENT = 10; // clamp per-node step to prevent explosion

/**
 * Compute total energy of the current layout.
 *
 * @param {import('./positions.js').PositionMap} posMap
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WeightVector} [W]
 * @returns {number}
 */
export function energy(posMap, edges, W) {
  let E = 0;
  const positions = posMap.positions;

  // Edge attraction: w * (dist - target)^2
  for (const [, edge] of edges) {
    const ps = positions.get(edge.source);
    const pt = positions.get(edge.target);
    if (!ps || !pt) continue;

    const dx = ps.x - pt.x;
    const dy = ps.y - pt.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const layerW = (W && W[edge.layer] != null) ? W[edge.layer] : 1.0;
    const w = (edge.weight || 1) * layerW;
    const target = DEFAULT_TARGET_DIST / Math.max(w, 0.1);
    E += w * (dist - target) ** 2;
  }

  // Repulsion (brute force for energy calculation — not used per-frame)
  const pts = toPointArray(posMap);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      const distSq = dx * dx + dy * dy;
      if (distSq > 0.01) {
        E += REPULSION_K / Math.sqrt(distSq);
      }
    }
  }

  // Pin energy
  for (const [, ps] of positions) {
    if (ps.locked) {
      const dx = ps.x - ps.t0x;
      const dy = ps.y - ps.t0y;
      E += PIN_K * (dx * dx + dy * dy);
    }
  }

  return E;
}

/**
 * Compute per-node gradient of E.
 *
 * @param {import('./positions.js').PositionMap} posMap
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WeightVector} [W]
 * @returns {Map<string, { gx: number, gy: number }>}
 */
export function gradEnergy(posMap, edges, W) {
  const grad = new Map();
  const positions = posMap.positions;

  // Initialize gradients to zero
  for (const [id] of positions) {
    grad.set(id, { gx: 0, gy: 0 });
  }

  // Edge attraction gradient: dE/dx_s = 2 * w * (1 - target/dist) * (x_s - x_t)
  for (const [, edge] of edges) {
    const ps = positions.get(edge.source);
    const pt = positions.get(edge.target);
    if (!ps || !pt) continue;

    const dx = ps.x - pt.x;
    const dy = ps.y - pt.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
    const layerW = (W && W[edge.layer] != null) ? W[edge.layer] : 1.0;
    const w = (edge.weight || 1) * layerW;
    const target = DEFAULT_TARGET_DIST / Math.max(w, 0.1);

    const factor = 2 * w * (1 - target / dist);
    const gx = factor * dx;
    const gy = factor * dy;

    const gs = grad.get(edge.source);
    const gt = grad.get(edge.target);
    if (gs) { gs.gx += gx; gs.gy += gy; }
    if (gt) { gt.gx -= gx; gt.gy -= gy; }
  }

  // Repulsion gradient via Barnes-Hut
  const pts = toPointArray(posMap);
  const tree = rebuild(pts);
  for (const p of pts) {
    const { fx, fy } = approximateRepulsion(tree, p, BH_THETA, REPULSION_K);
    const g = grad.get(p.id);
    if (g) {
      // Repulsion force is already in the right direction (away from others)
      // Gradient of repulsion energy = -force
      g.gx -= fx;
      g.gy -= fy;
    }
  }

  // Pin gradient
  for (const [id, ps] of positions) {
    if (ps.locked) {
      const g = grad.get(id);
      if (g) {
        g.gx += 2 * PIN_K * (ps.x - ps.t0x);
        g.gy += 2 * PIN_K * (ps.y - ps.t0y);
      }
    }
  }

  return grad;
}

/**
 * Compute the gradient norm (||gradE||).
 * @param {Map<string, { gx: number, gy: number }>} grad
 * @returns {number}
 */
export function gradNorm(grad) {
  let sum = 0;
  for (const [, g] of grad) {
    sum += g.gx * g.gx + g.gy * g.gy;
  }
  return Math.sqrt(sum);
}

/**
 * Perform one gradient descent step.
 * Mutates posMap in place.
 *
 * @param {import('./positions.js').PositionMap} posMap
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WeightVector} [W]
 * @param {Object} [options]
 * @param {number} [options.eta] - step size
 * @returns {{ gradMag: number }} gradient magnitude after step
 */
export function descentStep(posMap, edges, W, options) {
  const eta = (options && options.eta) || DEFAULT_ETA;
  const grad = gradEnergy(posMap, edges, W);

  for (const [id, ps] of posMap.positions) {
    if (ps.locked) continue;

    const g = grad.get(id);
    if (!g) continue;

    const stepScale = ps.sticky ? eta * STICKY_DAMPEN : eta;
    let dx = stepScale * g.gx;
    let dy = stepScale * g.gy;

    // Clamp displacement to prevent numerical explosion
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag > MAX_DISPLACEMENT) {
      const scale = MAX_DISPLACEMENT / mag;
      dx *= scale;
      dy *= scale;
    }

    ps.x -= dx;
    ps.y -= dy;
  }

  return { gradMag: gradNorm(grad) };
}
