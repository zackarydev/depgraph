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
import { isLayoutHub } from './hub-policy.js';

const DEFAULT_ETA = 0.1;
const STICKY_DAMPEN = 0.05;
const DEFAULT_TARGET_DIST = 100;
const PIN_K = 0.1;
const REPULSION_K = 500;
const BH_THETA = 0.7;
const MAX_DISPLACEMENT = 10; // clamp per-node step to prevent explosion
// Sub-pixel deadband: Barnes-Hut COM approximation produces small gradient
// noise even at equilibrium; high-mass scaffolding nodes amplify this into
// visible jitter at rest. Drop displacements below this threshold (world
// units) so near-equilibrium nodes settle instead of oscillating.
const DEADBAND = 0.05;

// Global bias added to every edge's stretch at gradient time. Driven by the
// zoom wiring in main.js so that zooming in amplifies the expand gesture and
// zooming out damps it. Set via setStretchBias(); 0 means identity.
let stretchBias = 0;
export function setStretchBias(b) { stretchBias = b; }
export function getStretchBias() { return stretchBias; }

// target = BASE * exp(stretch + bias). Free scalar, 0 = identity, ±∞ asymptotes.
function stretchedTarget(edge, w) {
  const s = (edge.stretch || 0) + stretchBias;
  // Coupling strength still modulates the base a little so importance edges
  // stay tighter than structural ones, but stretch is the dominant knob.
  return (DEFAULT_TARGET_DIST / Math.max(w, 0.1)) * Math.exp(s);
}

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

  // Edge attraction: w * (dist - target)^2, or w * ||Δ - rest||^2 when
  // a directional rest vector is set on the edge.
  for (const [, edge] of edges) {
    const ps = positions.get(edge.source);
    const pt = positions.get(edge.target);
    if (!ps || !pt) continue;

    const dx = ps.x - pt.x;
    const dy = ps.y - pt.y;
    const layerW = (W && W[edge.layer] != null) ? W[edge.layer] : 1.0;
    const w = (edge.weight || 1) * layerW;

    if (edge.restDx != null || edge.restDy != null) {
      const rdx = edge.restDx || 0;
      const rdy = edge.restDy || 0;
      E += w * ((dx - rdx) ** 2 + (dy - rdy) ** 2);
    } else {
      const dist = Math.sqrt(dx * dx + dy * dy);
      const target = stretchedTarget(edge, w);
      E += w * (dist - target) ** 2;
    }
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
export function gradEnergy(posMap, edges, W, nodes) {
  const grad = new Map();
  const positions = posMap.positions;

  // Initialize gradients to zero
  for (const [id] of positions) {
    grad.set(id, { gx: 0, gy: 0 });
  }

  // Edge attraction gradient.
  //
  // Scalar spring (default): E = w * (dist - target)^2, rotation-invariant,
  // pulls endpoints to a fixed distance.
  //   dE/dx_s = 2 * w * (1 - target/dist) * (x_s - x_t)
  //
  // Directional spring (edge.restDx/restDy set): E = w * ||Δ - rest||^2,
  // rotation-locked, pulls source to a specific offset from target.
  //   dE/dx_s = 2 * w * ((x_s - x_t) - restDx)
  //
  // Used by the markdown handler to encode indent (memberOf rest = (DX, 0))
  // and sibling stack (next rest = (0, -DY)) directly into the edge physics.
  for (const [, edge] of edges) {
    if (nodes && (isLayoutHub(nodes.get(edge.source)) || isLayoutHub(nodes.get(edge.target)))) continue;
    const ps = positions.get(edge.source);
    const pt = positions.get(edge.target);
    if (!ps || !pt) continue;

    const dx = ps.x - pt.x;
    const dy = ps.y - pt.y;
    const layerW = (W && W[edge.layer] != null) ? W[edge.layer] : 1.0;
    const w = (edge.weight || 1) * layerW;

    let gx, gy;
    if (edge.restDx != null || edge.restDy != null) {
      const rdx = edge.restDx || 0;
      const rdy = edge.restDy || 0;
      gx = 2 * w * (dx - rdx);
      gy = 2 * w * (dy - rdy);
    } else {
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const target = stretchedTarget(edge, w);
      const factor = 2 * w * (1 - target / dist);
      gx = factor * dx;
      gy = factor * dy;
    }

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
 * If `options.scope` is provided, the step runs in cluster-local mode: only
 * edges with BOTH endpoints in scope contribute to the gradient, repulsion
 * is computed only between scope pairs, and only scope nodes are moved.
 * Everything outside the scope is frozen — bridge edges crossing the scope
 * boundary are ignored for the duration of the step, so they cannot drag
 * members back out during a collapse burst.
 *
 * If `options.movable` is provided (and `scope` is not), the full gradient is
 * computed but only nodes in `movable` are displaced. Everything else stays
 * put but still contributes forces. Use this when a small set of new nodes
 * needs to settle without perturbing the rest of the layout.
 *
 * @param {import('./positions.js').PositionMap} posMap
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WeightVector} [W]
 * @param {Object} [options]
 * @param {number} [options.eta] - step size
 * @param {Set<string>} [options.scope] - cluster-local mode
 * @param {Set<string>} [options.movable] - full gradient, constrained displacement
 * @returns {{ gradMag: number }} gradient magnitude after step
 */
export function descentStep(posMap, edges, W, options) {
  const eta = (options && options.eta) || DEFAULT_ETA;
  const scope = options && options.scope;
  const collapse = options && options.collapse;
  const movable = options && options.movable;
  const nodes = options && options.nodes;

  const grad = scope
    ? scopedGradEnergy(posMap, edges, W, scope, collapse, nodes)
    : gradEnergy(posMap, edges, W, nodes);

  for (const [id, ps] of posMap.positions) {
    if (ps.locked) continue;
    if (scope && !scope.has(id)) continue;
    if (movable && !movable.has(id)) continue;

    const g = grad.get(id);
    if (!g) continue;

    const stepScale = ps.sticky ? eta * STICKY_DAMPEN : eta;
    const m = ps.mass || 1;
    let dx = (stepScale * g.gx) / m;
    let dy = (stepScale * g.gy) / m;

    if (Math.abs(dx) < DEADBAND) dx = 0;
    if (Math.abs(dy) < DEADBAND) dy = 0;
    if (dx === 0 && dy === 0) continue;

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

/**
 * Scope-restricted gradient: edges count only when both endpoints ∈ scope,
 * repulsion only between scope pairs. Used for cluster-local collapse/expand
 * bursts so bridge edges to outside nodes cannot fight the rule.
 */
function scopedGradEnergy(posMap, edges, W, scope, collapse, nodes) {
  const grad = new Map();
  const positions = posMap.positions;

  for (const id of scope) {
    if (nodes && isLayoutHub(nodes.get(id))) continue;
    grad.set(id, { gx: 0, gy: 0 });
  }

  // Compute centroid for centroid-pull during collapse.
  let cx = 0, cy = 0, cn = 0;
  for (const id of scope) {
    const p = positions.get(id);
    if (p) { cx += p.x; cy += p.y; cn++; }
  }
  if (cn) { cx /= cn; cy /= cn; }

  // Detect collapse from edges OR from the explicit flag (needed when the
  // cluster has no internal edges — only memberOf edges to a virtual node).
  let stretchSum = 0, stretchCount = 0;

  for (const [, edge] of edges) {
    if (!scope.has(edge.source) || !scope.has(edge.target)) continue;
    if (nodes && (isLayoutHub(nodes.get(edge.source)) || isLayoutHub(nodes.get(edge.target)))) continue;
    const ps = positions.get(edge.source);
    const pt = positions.get(edge.target);
    if (!ps || !pt) continue;

    stretchSum += (edge.stretch || 0);
    stretchCount++;

    const dx = ps.x - pt.x;
    const dy = ps.y - pt.y;
    const layerW = (W && W[edge.layer] != null) ? W[edge.layer] : 1.0;
    const w = (edge.weight || 1) * layerW;

    let gx, gy;
    if (edge.restDx != null || edge.restDy != null) {
      const rdx = edge.restDx || 0;
      const rdy = edge.restDy || 0;
      gx = 2 * w * (dx - rdx);
      gy = 2 * w * (dy - rdy);
    } else {
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const target = stretchedTarget(edge, w);
      const factor = 2 * w * (1 - target / dist);
      gx = factor * dx;
      gy = factor * dy;
    }

    const gs = grad.get(edge.source);
    const gt = grad.get(edge.target);
    if (gs) { gs.gx += gx; gs.gy += gy; }
    if (gt) { gt.gx -= gx; gt.gy -= gy; }
  }

  const collapsing = collapse || (stretchCount > 0 && stretchSum / stretchCount < -0.5);

  // When collapsing, add a centroid-pull that drives all members toward their
  // center of mass — this dominates over repulsion and guarantees convergence
  // even when members share no internal edges.
  if (collapsing && cn > 0) {
    const pullK = 0.5;
    for (const id of scope) {
      const p = positions.get(id);
      if (!p) continue;
      const g = grad.get(id);
      if (!g) continue;
      g.gx += pullK * (p.x - cx);
      g.gy += pullK * (p.y - cy);
    }
  }

  // Brute-force pairwise repulsion among scope members. When collapsing,
  // suppress repulsion so nodes can actually converge.
  const repulsionScale = collapsing ? 0.02 : 1.0;
  const ids = [...scope];
  for (let i = 0; i < ids.length; i++) {
    const pi = positions.get(ids[i]);
    if (!pi) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const pj = positions.get(ids[j]);
      if (!pj) continue;
      const dx = pi.x - pj.x;
      const dy = pi.y - pj.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < 0.01) continue;
      const dist = Math.sqrt(distSq);
      const f = repulsionScale * REPULSION_K / (dist * distSq);
      const gi = grad.get(ids[i]);
      const gj = grad.get(ids[j]);
      if (gi) { gi.gx -= f * dx; gi.gy -= f * dy; }
      if (gj) { gj.gx += f * dx; gj.gy += f * dy; }
    }
  }

  return grad;
}
