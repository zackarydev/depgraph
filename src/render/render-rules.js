/**
 * Visual LOD rules. Replaces the per-tier display:none model from
 * fractal-lod.js with continuous opacity ramps driven by class + zoom.
 *
 * Two LODs:
 *   A — structural graph (always visible at default zoom). Cluster-target
 *       nodes (file/heading/paragraph), structural edges (memberOf, calls),
 *       and leaf nodes as small circles. The whole document outline is
 *       readable at once.
 *   B — leaf content (fades in past zoom threshold). Pixel circles + lattice
 *       edges, leaf-text labels (handled by applySemanticZoom screen-radius).
 *
 * Rules are independent selectors run in order; the last match wins
 * (paint-order semantics). A rule's opacity returns 0..1.
 *
 * Adding a rule: append to NODE_RULES or EDGE_RULES with { name, match,
 * opacity, target? }. `target` narrows from the <g> container to a
 * sub-element ('rect' | 'circle'). No registration step required.
 *
 * Debug mode (state.lodDebug=true) keeps "hidden" elements at HIDDEN_DEBUG
 * opacity instead of display:none — surfaces what was suppressed.
 *
 * @module render/render-rules
 */

const IMAGE_KINDS = new Set(['pixel', 'image-header']);
const IMAGE_EDGE_LAYERS = new Set(['next-x', 'next-y', 'image-root']);

// Reusable opacity ramps. fadeIn returns 0 below kStart, max above kEnd,
// linear in between. fadeOut is the inverse.
function fadeIn(k, kStart, kEnd, max = 1) {
  if (k <= kStart) return 0;
  if (k >= kEnd) return max;
  return ((k - kStart) / (kEnd - kStart)) * max;
}

function fadeOut(k, kStart, kEnd, min = 0) {
  if (k <= kStart) return 1;
  if (k >= kEnd) return min;
  return 1 - ((k - kStart) / (kEnd - kStart)) * (1 - min);
}

const HIDDEN = 0;
const HIDDEN_DEBUG = 0.08;

/**
 * @typedef {Object} NodeRule
 * @property {string} name
 * @property {(node, ctx) => boolean} match
 * @property {(k, ctx, node) => number} opacity
 * @property {'rect'|'circle'} [target] — sub-element. Default: <g> container.
 */

export const NODE_RULES = [
  // (1) Layout hubs — slot/value nodes encode positions and metadata. Never
  //     visible to the user.
  { name: 'slot-hidden',
    match: (n) => n.kind === 'slot' || n.kind === 'value',
    opacity: () => HIDDEN },

  // (2) Image rect (LOD A for image content) — opaque at low k where the
  //     pixels tile into a thumbnail; fades as the per-pixel circles emerge.
  { name: 'pixel-rect',
    target: 'rect',
    match: (n) => n.kind === 'pixel',
    opacity: (k) => k <= 1.2 ? 1 : k >= 4 ? 0.1 : 1 - ((k - 1.2) / (4 - 1.2)) * 0.9 },

  // (3) Image circle (LOD B for image content) — emerges past the
  //     peek-behind threshold so lattice edges have something to terminate on.
  { name: 'pixel-circle',
    target: 'circle',
    match: (n) => n.kind === 'pixel',
    opacity: (k) => fadeIn(k, 1.5, 3.5) },

  // (4) Pixel container <g> stays present so its rect can paint. Without
  //     this, rule (2)'s rect target would be invisible because the
  //     container defaults to `default` opacity which... is also 1, but be
  //     explicit so future rules don't accidentally hide it.
  { name: 'pixel-container',
    match: (n) => n.kind === 'pixel',
    opacity: () => 1 },

  // (5) Image header — anchor sprite for an image. Always visible.
  { name: 'image-header',
    match: (n) => n.kind === 'image-header',
    opacity: () => 1 },

  // (6) Default: every other node is visible. Structural nodes
  //     (clusterTargets) and text leaves alike. Their labels fade by
  //     screen-radius via applySemanticZoom — that's the LOD B reveal for
  //     text content.
  { name: 'default',
    match: () => true,
    opacity: () => 1 },
];

/**
 * @typedef {Object} EdgeRule
 * @property {string} name
 * @property {(edge, ctx) => boolean} match
 * @property {(k, ctx, edge) => number} opacity
 */

export const EDGE_RULES = [
  // (1) Default: visible.
  { name: 'default',
    match: () => true,
    opacity: () => 1 },

  // (2) memberOf — structural skeleton of nested clusters. Soft so the
  //     content edges (calls, binds, shared) read first.
  { name: 'memberOf-soft',
    match: (e) => e.layer === 'memberOf',
    opacity: () => 0.45 },

  // (3) Image lattice (next-x / next-y / image-root) — the cross-hatch over
  //     the image. Hidden until pixel circles emerge.
  { name: 'image-lattice',
    match: (e) => IMAGE_EDGE_LAYERS.has(e.layer),
    opacity: (k) => fadeIn(k, 1.5, 3.5) },
];

// ─── DOM update helpers (idempotent — cache last applied value) ───────

function setStyleOpacity(el, op, cacheKey) {
  const s = String(op);
  if (el[cacheKey] === s) return;
  el.style.opacity = s;
  el[cacheKey] = s;
}

function setStyleDisplay(el, hidden, cacheKey) {
  const value = hidden ? 'none' : '';
  if (el[cacheKey] === value) return;
  el.style.display = value;
  el[cacheKey] = value;
}

function setAttrIfChanged(el, name, value, cacheKey) {
  const s = String(value);
  if (el[cacheKey] === s) return;
  el.setAttribute(name, s);
  el[cacheKey] = s;
}

/**
 * Walk the rule lists and apply opacity to every node/edge in the renderer
 * state. Idempotent — caches the last applied value per element. Cheap
 * enough to call on every zoom event (continuous wheel scroll).
 *
 * @param {Object} state - v3 renderer state
 * @param {Object} deps - { graph, ... }
 * @param {number} k - current zoom scale
 */
export function applyRenderRules(state, deps, k) {
  if (!deps || !deps.graph) return;
  const { graph } = deps;
  const debug = !!state.lodDebug;
  const fl = state.fractalLod;
  const clusterTargets = fl ? fl.clusterTargets : new Set();
  const ctx = { clusterTargets, k };

  // ─── Nodes ────────────────────────────────────────────────────────
  for (const [id, g] of state.nodeElements) {
    const node = graph.state.nodes.get(id);
    if (!node) continue;

    let nodeOp = 1;
    let circleOp = null;
    let rectOp = null;

    for (const rule of NODE_RULES) {
      if (!rule.match(node, ctx)) continue;
      const op = rule.opacity(k, ctx, node);
      if (rule.target === 'circle') circleOp = op;
      else if (rule.target === 'rect') rectOp = op;
      else nodeOp = op;
    }

    // Hidden nodes become display:none in production (cuts hit-testing and
    // paint cost). In debug they stay faintly visible so suppressed nodes
    // are inspectable.
    if (nodeOp <= HIDDEN && !debug) {
      setStyleDisplay(g, true, '_lodDisp');
      continue;
    }
    setStyleDisplay(g, false, '_lodDisp');
    const finalOp = nodeOp <= HIDDEN ? HIDDEN_DEBUG : nodeOp;
    setStyleOpacity(g, finalOp, '_lodOp');

    if (rectOp !== null) {
      const rect = state.nodeRectElements.get(id);
      if (rect) setAttrIfChanged(rect, 'opacity', rectOp, '_lodOp');
    }
    if (circleOp !== null) {
      const circle = state.nodeCircleElements.get(id);
      if (circle) setAttrIfChanged(circle, 'opacity', circleOp, '_lodOp');
    }
  }

  // ─── Labels ───────────────────────────────────────────────────────
  // applySemanticZoom drives label opacity by screen-radius — that's the
  // LOD B reveal for leaf text. But structural labels (cluster targets:
  // file/heading/paragraph names) are the document outline, so they stay
  // readable at all zooms. Override here after applySemanticZoom has run.
  for (const [id, t] of state.labelElements) {
    const node = graph.state.nodes.get(id);
    if (!node) continue;
    if (clusterTargets.has(id)) {
      // Share `_lastOp` with applySemanticZoom — that pass writes the same
      // `opacity` attribute first, so a separate cache key would let our
      // override no-op while the DOM still reads the faded value.
      setAttrIfChanged(t, 'opacity', '1', '_lastOp');
    }
    // Hide labels for kinds whose container is hidden, so we don't get
    // ghost text floating where a slot used to be.
    if (node.kind === 'slot' || node.kind === 'value') {
      setStyleDisplay(t, !debug, '_lodLabelDisp');
    } else {
      setStyleDisplay(t, false, '_lodLabelDisp');
    }
  }

  // ─── Edges ────────────────────────────────────────────────────────
  for (const [key, line] of state.edgeElements) {
    if (!key.startsWith('e:')) {
      // Meta edges keep their existing semantics — gMeta layer display +
      // opacity are managed in v3.js applySemanticZoom. Don't double-touch.
      continue;
    }
    const edge = graph.state.edges.get(key.slice(2));
    if (!edge) continue;

    let v = 1;
    for (const rule of EDGE_RULES) {
      if (!rule.match(edge, ctx)) continue;
      v = rule.opacity(k, ctx, edge);
    }

    const arrow = state.arrowElements && state.arrowElements.get(key);
    if (v <= HIDDEN && !debug) {
      setStyleDisplay(line, true, '_lodDisp');
      if (arrow) setStyleDisplay(arrow, true, '_lodDisp');
      continue;
    }
    setStyleDisplay(line, false, '_lodDisp');
    const finalOp = v <= HIDDEN ? HIDDEN_DEBUG : v;
    setStyleOpacity(line, finalOp, '_lodOp');
    if (arrow) {
      setStyleDisplay(arrow, false, '_lodDisp');
      setStyleOpacity(arrow, finalOp, '_lodOp');
    }
  }
}
