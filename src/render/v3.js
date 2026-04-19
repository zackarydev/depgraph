/**
 * v3 renderer — simplified replacement for render/legacy.js.
 *
 * Cuts from legacy:
 *   - no hit-rect on cluster labels (pointer events live on the text itself)
 *   - no affinity rings / multi-affinity color blending (single cluster color)
 *   - no textPath boundary labels around hulls
 *   - no separate meta-link pipeline (unified into the edge diff)
 *
 * Keeps from legacy:
 *   - proximity-gradient edges (end-solid, mid-fading)
 *   - cluster hulls (convex hull + padding), rebuilt every frame from display
 *     positions across all members (no LOD filter — a future cluster-collapse
 *     rule will handle aggregation)
 *   - cluster floating labels (simple text only)
 *   - node label zoom fade-in
 *
 * Entry points (mirrors legacy's API so main.js just swaps imports):
 *   createRenderer(svgCtx)
 *   renderFull(state, deps)
 *   renderPositionsOnly(state, deps)
 *   applySemanticZoom(state, deps, k)
 *   setShowFlag(state, name, value)
 *   renderSelectionGlow(state, selection)
 *   clusterColor(cid), clusterShortName(cid)
 *   LOD_SLOT_THRESHOLD, isLowLodKind(kind)
 *
 * @module render/v3
 */

import { getLayer } from '../edges/layers.js';
import { buildClusterIndex } from '../data/derive.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const CLUSTER_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8',
  '#ff922b', '#22b8cf', '#ff6b9d', '#a9e34b', '#748ffc',
  '#f06595', '#20c997', '#fd7e14', '#845ef7', '#12b886',
  '#e64980', '#7950f2', '#15aabf', '#fab005', '#82c91e',
];

function clusterColorIndex(clusterId) {
  let h = 0;
  const s = String(clusterId || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % CLUSTER_COLORS.length;
}

export function clusterColor(clusterId) {
  if (clusterId == null) return '#808080';
  return CLUSTER_COLORS[clusterColorIndex(clusterId)];
}

export function clusterShortName(clusterId) {
  if (!clusterId) return '?';
  return String(clusterId).replace(/^(cluster:)+/, '');
}

const LOD_SLOT_THRESHOLD = 3;
export { LOD_SLOT_THRESHOLD };

export function isLowLodKind(kind) {
  return kind === 'slot' || kind === 'value';
}

function shouldSkipForLod(node, k) {
  if (!node) return false;
  if (k >= LOD_SLOT_THRESHOLD) return false;
  return isLowLodKind(node.kind);
}

const KIND_COLOR = {
  function: '#4a90d9',
  global:   '#e74c3c',
  module:   '#2ecc71',
  cluster:  '#9b59b6',
  parameter:'#f39c12',
  value:    '#1abc9c',
};

function nodeKindColor(kind) {
  return KIND_COLOR[kind] || '#95a5a6';
}

function nodeRadius(node) {
  const imp = (node && node.importance != null) ? node.importance : 1;
  return 3 + Math.min(6, Math.sqrt(imp) * 2.2);
}

function brighten(hex, amount) {
  const p = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((p >> 16) & 0xff) * (1 + amount)));
  const g = Math.min(255, Math.round(((p >> 8) & 0xff) * (1 + amount)));
  const b = Math.min(255, Math.round((p & 0xff) * (1 + amount)));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function blendHex(a, b) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = (((pa >> 16) & 0xff) + ((pb >> 16) & 0xff)) >> 1;
  const g = (((pa >> 8) & 0xff) + ((pb >> 8) & 0xff)) >> 1;
  const bl = ((pa & 0xff) + (pb & 0xff)) >> 1;
  return '#' + ((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0');
}

function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function convexHull(points) {
  if (!points || points.length < 3) return null;
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function expandHull(hull, pad) {
  let cx = 0, cy = 0;
  for (const [x, y] of hull) { cx += x; cy += y; }
  cx /= hull.length; cy /= hull.length;
  return hull.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return [x + (dx / d) * pad, y + (dy / d) * pad];
  });
}

function edgeMidOpacity(dist) {
  const CLOSE = 60, FAR = 250;
  if (dist <= CLOSE) return 1.0;
  if (dist >= FAR) return 0.08;
  return 1.0 - ((dist - CLOSE) / (FAR - CLOSE)) * 0.92;
}

/* =====================================================================
 * Renderer state
 * =================================================================== */

export function createRenderer(svgCtx) {
  return {
    svgCtx,
    nodeElements:        new Map(), // id -> <g class=node>
    nodeCircleElements:  new Map(), // id -> <circle>
    labelElements:       new Map(), // id -> <text>
    edgeElements:        new Map(), // edgeKey -> <line>
    arrowElements:       new Map(), // edgeKey -> <path>
    gradientElements:    new Map(), // edgeKey -> { grad, stops, _endSet, _midOp, color }
    hullElements:        new Map(), // clusterId -> { path }
    clusterLabelElements:new Map(), // clusterId -> <text>
    clusterIndex:        new Map(), // nodeId -> clusterId
    clusterMembers:      new Map(), // clusterId -> string[]
    clusterLabelOffset:  new Map(), // clusterId -> { dx, dy }
    displayPositions:    new Map(), // id -> { x, y }
    flags: {
      labels: true,
      hulls: true,
      clusterLabels: true,
      edges: true,
      metaEdges: true,
    },
    smoothMotion: false,
    currentK: 1,
  };
}

export function setShowFlag(state, name, value) {
  state.flags[name] = !!value;
}

/* =====================================================================
 * Full redraw
 * =================================================================== */

export function renderFull(state, deps) {
  const { graph, posMap, derivation } = deps;
  if (!state.svgCtx) return;

  state.clusterIndex = buildClusterIndex(derivation.clusters);
  state.clusterMembers = new Map();
  for (const [cid, cl] of derivation.clusters) {
    state.clusterMembers.set(cid, [...cl.members]);
  }

  renderEdgesDiff(state, graph, posMap);
  renderNodesDiff(state, graph, posMap);
  renderLabelsDiff(state, graph, posMap);
  ensureHullElements(state);
  ensureClusterLabelElements(state);
  rebuildHulls(state, posMap);
  positionClusterLabels(state, posMap);
  applySemanticZoom(state, deps, state.currentK);
  renderSelectionGlow(state, deps.selection);
}

/* =====================================================================
 * Edges — regular graph edges + virtual meta-edges, both through one path
 * =================================================================== */

function renderEdgesDiff(state, graph, posMap) {
  const { svgCtx, edgeElements, arrowElements, gradientElements } = state;
  const gLinks = svgCtx.layers.gLinks;
  const gMeta = svgCtx.layers.gMetaLinks;
  const defs = svgCtx.defs;
  const seen = new Set();
  const k = state.currentK || 1;

  // Regular edges
  for (const [id, edge] of graph.state.edges) {
    const layerDef = getLayer(edge.layer);
    if (layerDef && layerDef.visible === false) continue;
    const sn = graph.state.nodes.get(edge.source);
    const tn = graph.state.nodes.get(edge.target);
    if (shouldSkipForLod(sn, k) || shouldSkipForLod(tn, k)) continue;
    const ps = posMap.positions.get(edge.source);
    const pt = posMap.positions.get(edge.target);
    if (!ps || !pt) continue;
    const color = layerDef ? layerDef.color : '#4a9eff';
    const directed = !!(layerDef && layerDef.directed);
    const dash = layerDef ? layerDef.dash : null;
    const key = `e:${id}`;
    upsertEdge(state, key, gLinks, defs, edge.source, edge.target, color, directed, dash, edge.weight, ps, pt);
    seen.add(key);
  }

  // Virtual meta-edges (inter-cluster coupling → line between centroids)
  if (state.flags.metaEdges && k < 1.5) {
    const coupling = new Map();
    for (const [, edge] of graph.state.edges) {
      const ca = state.clusterIndex.get(edge.source);
      const cb = state.clusterIndex.get(edge.target);
      if (!ca || !cb || ca === cb) continue;
      const [a, b] = ca < cb ? [ca, cb] : [cb, ca];
      const mkey = a + '\0' + b;
      coupling.set(mkey, (coupling.get(mkey) || 0) + (edge.weight || 1));
    }
    const maxCoupling = Math.max(1, ...coupling.values());
    for (const [mkey, w] of coupling) {
      const sep = mkey.indexOf('\0');
      const a = mkey.slice(0, sep);
      const b = mkey.slice(sep + 1);
      const s = clusterCentroid(state, posMap, a);
      const t = clusterCentroid(state, posMap, b);
      if (!s || !t) continue;
      const nw = w / maxCoupling;
      const color = blendHex(clusterColor(a), clusterColor(b));
      const key = `m:${mkey}`;
      upsertEdge(state, key, gMeta, defs, a, b, color, false, null, 0.5 + nw * 4, s, t);
      seen.add(key);
    }
  }

  for (const [key, el] of edgeElements) {
    if (!seen.has(key)) {
      el.remove();
      edgeElements.delete(key);
      const g = gradientElements.get(key);
      if (g) { g.grad.remove(); gradientElements.delete(key); }
      const a = arrowElements.get(key);
      if (a) { a.remove(); arrowElements.delete(key); }
    }
  }
}

function upsertEdge(state, key, layer, defs, sourceId, targetId, color, directed, dash, weight, ps, pt) {
  const { edgeElements, arrowElements, gradientElements } = state;

  let grad = gradientElements.get(key);
  if (!grad) {
    const gradEl = document.createElementNS(SVG_NS, 'linearGradient');
    gradEl.setAttribute('id', `edge-grad-${cssId(key)}`);
    gradEl.setAttribute('gradientUnits', 'userSpaceOnUse');
    const stops = [];
    for (const off of ['0%', '25%', '50%', '75%', '100%']) {
      const s = document.createElementNS(SVG_NS, 'stop');
      s.setAttribute('offset', off);
      s.setAttribute('stop-color', color);
      gradEl.appendChild(s);
      stops.push(s);
    }
    defs.appendChild(gradEl);
    grad = { grad: gradEl, stops, color };
    gradientElements.set(key, grad);
  } else if (grad.color !== color) {
    for (const s of grad.stops) s.setAttribute('stop-color', color);
    grad.color = color;
  }
  updateGradient(grad, ps.x, ps.y, pt.x, pt.y);

  let line = edgeElements.get(key);
  if (!line) {
    line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'link');
    line.setAttribute('data-key', key);
    layer.appendChild(line);
    edgeElements.set(key, line);
  }
  line.setAttribute('data-source', sourceId);
  line.setAttribute('data-target', targetId);
  line.setAttribute('x1', ps.x);
  line.setAttribute('y1', ps.y);
  line.setAttribute('x2', pt.x);
  line.setAttribute('y2', pt.y);
  line.setAttribute('stroke', `url(#${grad.grad.getAttribute('id')})`);
  line.setAttribute('stroke-width', String(Math.max(0.5, Math.min(3, 0.5 + (weight || 1) * 0.3))));
  line.setAttribute('stroke-opacity', '0.85');
  if (dash) line.setAttribute('stroke-dasharray', dash);
  else line.removeAttribute('stroke-dasharray');

  if (directed) {
    let arrow = arrowElements.get(key);
    if (!arrow) {
      arrow = document.createElementNS(SVG_NS, 'path');
      arrow.setAttribute('class', 'arrow');
      layer.appendChild(arrow);
      arrowElements.set(key, arrow);
    }
    updateArrow(arrow, ps.x, ps.y, pt.x, pt.y);
    arrow.setAttribute('fill', color);
    arrow.setAttribute('fill-opacity', '0.85');
  } else if (arrowElements.has(key)) {
    arrowElements.get(key).remove();
    arrowElements.delete(key);
  }
}

function updateGradient(grad, sx, sy, tx, ty) {
  grad.grad.setAttribute('x1', sx);
  grad.grad.setAttribute('y1', sy);
  grad.grad.setAttribute('x2', tx);
  grad.grad.setAttribute('y2', ty);
  const dist = Math.hypot(tx - sx, ty - sy);
  const midOp = edgeMidOpacity(dist);
  if (!grad._endSet) {
    grad.stops[0].setAttribute('stop-opacity', '1');
    grad.stops[4].setAttribute('stop-opacity', '1');
    grad._endSet = true;
  }
  if (grad._midOp !== midOp) {
    grad.stops[1].setAttribute('stop-opacity', String(midOp));
    grad.stops[2].setAttribute('stop-opacity', String(midOp * 0.7));
    grad.stops[3].setAttribute('stop-opacity', String(midOp));
    grad._midOp = midOp;
  }
}

function updateArrow(arrow, sx, sy, tx, ty) {
  const dx = tx - sx, dy = ty - sy;
  const len = Math.hypot(dx, dy);
  if (len < 1) { arrow.setAttribute('d', ''); return; }
  const ux = dx / len, uy = dy / len;
  const tr = 5;
  const tipX = tx - ux * tr, tipY = ty - uy * tr;
  const sz = 3;
  const bx = tipX - ux * sz, by = tipY - uy * sz;
  const px = -uy * sz * 0.5, py = ux * sz * 0.5;
  arrow.setAttribute('d', `M${tipX},${tipY} L${bx + px},${by + py} L${bx - px},${by - py}Z`);
}

/* =====================================================================
 * Nodes — single circle, color from cluster (or kind fallback)
 * =================================================================== */

function renderNodesDiff(state, graph, posMap) {
  const { svgCtx, nodeElements, nodeCircleElements, clusterIndex } = state;
  const gNodes = svgCtx.layers.gNodes;
  const seen = new Set();
  const k = state.currentK || 1;

  for (const [id, node] of graph.state.nodes) {
    if (shouldSkipForLod(node, k)) continue;
    const ps = posMap.positions.get(id);
    if (!ps) continue;
    seen.add(id);

    const cid = clusterIndex.get(id);
    const baseColor = cid ? clusterColor(cid) : nodeKindColor(node.kind);
    const r = nodeRadius(node);

    let g = nodeElements.get(id);
    if (!g) {
      g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'node');
      g.setAttribute('data-id', id);
      gNodes.appendChild(g);
      nodeElements.set(id, g);
    }
    g.setAttribute('transform', `translate(${ps.x},${ps.y})`);

    let circle = nodeCircleElements.get(id);
    if (!circle) {
      circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('class', 'node-circle');
      g.appendChild(circle);
      nodeCircleElements.set(id, circle);
    }
    circle.setAttribute('r', r);
    circle.setAttribute('fill', node.kind === 'global' ? '#333' : baseColor);
    circle.setAttribute('stroke', node.kind === 'global' ? '#666' : brighten(baseColor, 0.35));
    circle.setAttribute('stroke-width', '1.5');
  }

  for (const [id, el] of nodeElements) {
    if (!seen.has(id)) {
      el.remove();
      nodeElements.delete(id);
      nodeCircleElements.delete(id);
    }
  }
}

/* =====================================================================
 * Node labels
 * =================================================================== */

function renderLabelsDiff(state, graph, posMap) {
  const { svgCtx, labelElements } = state;
  const gLabels = svgCtx.layers.gLabels;
  const seen = new Set();
  const k = state.currentK || 1;

  for (const [id, node] of graph.state.nodes) {
    if (shouldSkipForLod(node, k)) continue;
    const ps = posMap.positions.get(id);
    if (!ps) continue;
    seen.add(id);
    let text = labelElements.get(id);
    if (!text) {
      text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'label');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('fill', '#fff');
      text.setAttribute('font-size', '9');
      text.setAttribute('pointer-events', 'none');
      gLabels.appendChild(text);
      labelElements.set(id, text);
    }
    text.setAttribute('x', ps.x);
    text.setAttribute('y', ps.y);
    const want = node.label || id;
    if (text.textContent !== want) text.textContent = want;
  }

  for (const [id, el] of labelElements) {
    if (!seen.has(id)) { el.remove(); labelElements.delete(id); }
  }
}

/* =====================================================================
 * Hulls — rebuilt every frame from display positions, all members
 * =================================================================== */

function ensureHullElements(state) {
  const { svgCtx, hullElements } = state;
  const gHulls = svgCtx.layers.gHulls;
  const seen = new Set();
  for (const [cid, members] of state.clusterMembers) {
    if (!members || members.length < 3) continue;
    seen.add(cid);
    if (!hullElements.has(cid)) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'hull');
      const color = clusterColor(cid);
      path.setAttribute('fill', color);
      path.setAttribute('stroke', color);
      path.setAttribute('fill-opacity', '0.08');
      path.setAttribute('stroke-opacity', '0.25');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('pointer-events', 'none');
      gHulls.appendChild(path);
      hullElements.set(cid, { path });
    }
  }
  for (const [cid, he] of hullElements) {
    if (!seen.has(cid)) { he.path.remove(); hullElements.delete(cid); }
  }
}

function rebuildHulls(state, posMap) {
  for (const [cid, he] of state.hullElements) {
    const members = state.clusterMembers.get(cid);
    if (!members) continue;
    const pts = [];
    for (const mid of members) {
      const dp = state.displayPositions.get(mid) || posMap.positions.get(mid);
      if (dp) pts.push([dp.x, dp.y]);
    }
    if (pts.length < 3) continue;
    const hull = convexHull(pts);
    if (!hull || hull.length < 3) continue;
    const expanded = expandHull(hull, 20);
    const d = `M${expanded.map(p => p.join(',')).join('L')}Z`;
    if (he._lastD === d) continue;
    he.path.setAttribute('d', d);
    he._lastD = d;
  }
}

/* =====================================================================
 * Cluster labels — plain <text> with pointer-events on itself, cursor: grab.
 * No hit-rect. `data-cluster` on the text element for drag delegation.
 * =================================================================== */

function ensureClusterLabelElements(state) {
  const { svgCtx, clusterLabelElements } = state;
  const gClusterLabels = svgCtx.layers.gClusterLabels;
  const seen = new Set();
  for (const [cid, members] of state.clusterMembers) {
    if (!members || members.length === 0) continue;
    seen.add(cid);
    if (!clusterLabelElements.has(cid)) {
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'cluster-label');
      text.setAttribute('data-cluster', cid);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('font-weight', '600');
      text.setAttribute('fill', clusterColor(cid));
      text.setAttribute('fill-opacity', '0.6');
      text.style.cursor = 'grab';
      text.textContent = clusterShortName(cid);
      gClusterLabels.appendChild(text);
      clusterLabelElements.set(cid, text);
    }
  }
  for (const [cid, el] of clusterLabelElements) {
    if (!seen.has(cid)) { el.remove(); clusterLabelElements.delete(cid); }
  }
}

function positionClusterLabels(state, posMap) {
  for (const [cid, text] of state.clusterLabelElements) {
    const members = state.clusterMembers.get(cid);
    if (!members || members.length === 0) continue;
    let cx = 0, cy = 0, n = 0, minY = Infinity;
    for (const mid of members) {
      const p = state.displayPositions.get(mid) || posMap.positions.get(mid);
      if (!p) continue;
      cx += p.x; cy += p.y; n++;
      if (p.y < minY) minY = p.y;
    }
    if (n === 0) continue;
    cx /= n; cy /= n;
    if (!state.clusterLabelOffset.has(cid)) {
      state.clusterLabelOffset.set(cid, { dx: 0, dy: (minY - 18) - cy });
    }
    const off = state.clusterLabelOffset.get(cid);
    const tx = cx + off.dx, ty = cy + off.dy;
    if (Math.abs(tx - text._lastX) < 0.05 && Math.abs(ty - text._lastY) < 0.05) continue;
    text.setAttribute('x', tx);
    text.setAttribute('y', ty);
    text._lastX = tx; text._lastY = ty;
  }
}

function clusterCentroid(state, posMap, cid) {
  const members = state.clusterMembers.get(cid);
  if (!members || members.length === 0) return null;
  let cx = 0, cy = 0, n = 0;
  for (const mid of members) {
    const p = state.displayPositions.get(mid) || posMap.positions.get(mid);
    if (!p) continue;
    cx += p.x; cy += p.y; n++;
  }
  if (!n) return null;
  return { x: cx / n, y: cy / n };
}

/* =====================================================================
 * Per-frame position update
 * =================================================================== */

export function renderPositionsOnly(state, deps) {
  const { posMap } = deps;
  if (!state.svgCtx) return;

  const display = state.displayPositions;
  const smooth = !!state.smoothMotion;
  const LERP = 0.18;
  const EPS = 0.05;

  for (const [id, g] of state.nodeElements) {
    const ps = posMap.positions.get(id);
    if (!ps) continue;
    let dp = display.get(id);
    if (!dp) { dp = { x: ps.x, y: ps.y }; display.set(id, dp); }
    if (smooth) {
      dp.x += (ps.x - dp.x) * LERP;
      dp.y += (ps.y - dp.y) * LERP;
    } else {
      dp.x = ps.x; dp.y = ps.y;
    }
    if (Math.abs(dp.x - g._lastX) >= EPS || Math.abs(dp.y - g._lastY) >= EPS
        || g._lastX === undefined) {
      g.setAttribute('transform', `translate(${dp.x},${dp.y})`);
      g._lastX = dp.x; g._lastY = dp.y;
    }
  }

  for (const [id, text] of state.labelElements) {
    const dp = display.get(id);
    if (!dp) continue;
    if (Math.abs(dp.x - text._lastX) >= EPS || Math.abs(dp.y - text._lastY) >= EPS
        || text._lastX === undefined) {
      text.setAttribute('x', dp.x);
      text.setAttribute('y', dp.y);
      text._lastX = dp.x; text._lastY = dp.y;
    }
  }

  // Edges — endpoints may be a regular node OR a cluster centroid (meta edge).
  for (const [key, line] of state.edgeElements) {
    const sid = line.getAttribute('data-source');
    const tid = line.getAttribute('data-target');
    const ds = endpointPoint(state, posMap, sid);
    const dt = endpointPoint(state, posMap, tid);
    if (!ds || !dt) continue;
    const sMoved = Math.abs(ds.x - line._sx) >= EPS || Math.abs(ds.y - line._sy) >= EPS
      || line._sx === undefined;
    const tMoved = Math.abs(dt.x - line._tx) >= EPS || Math.abs(dt.y - line._ty) >= EPS
      || line._tx === undefined;
    if (!sMoved && !tMoved) continue;
    if (sMoved) {
      line.setAttribute('x1', ds.x); line.setAttribute('y1', ds.y);
      line._sx = ds.x; line._sy = ds.y;
    }
    if (tMoved) {
      line.setAttribute('x2', dt.x); line.setAttribute('y2', dt.y);
      line._tx = dt.x; line._ty = dt.y;
    }
    const grad = state.gradientElements.get(key);
    if (grad) updateGradient(grad, ds.x, ds.y, dt.x, dt.y);
    const arrow = state.arrowElements.get(key);
    if (arrow) updateArrow(arrow, ds.x, ds.y, dt.x, dt.y);
  }

  rebuildHulls(state, posMap);
  positionClusterLabels(state, posMap);
}

function endpointPoint(state, posMap, id) {
  // Meta-edge endpoints are cluster ids. Regular edges use node ids.
  if (state.clusterMembers.has(id)) return clusterCentroid(state, posMap, id);
  return state.displayPositions.get(id) || posMap.positions.get(id);
}

/* =====================================================================
 * Semantic zoom — opacity/font-size by k
 * =================================================================== */

export function applySemanticZoom(state, deps, k) {
  if (!state.svgCtx) return;
  state.currentK = k;

  // Top-level short-circuit. On a stable wheel-idle frame, nothing about
  // k or flags changes — but the zoom handler still fires this on every
  // pointer event. Signature-compare and bail before touching the DOM.
  const f = state.flags;
  const sig = (state._zoomSig ||= {});
  const sameK = typeof sig.k === 'number' && Math.abs(sig.k - k) < K_EPS;
  const sameFlags = sig.hulls === f.hulls && sig.labels === f.labels
    && sig.clusterLabels === f.clusterLabels && sig.metaEdges === f.metaEdges
    && sig.edges === f.edges;
  const sameCounts = sig.nHulls === state.hullElements.size
    && sig.nClusterLabels === state.clusterLabelElements.size
    && sig.nLabels === state.labelElements.size;
  if (sameK && sameFlags && sameCounts) return;

  const hullOp = k < 0.5 ? 0.15 : k < 1.5 ? 0.08 : 0.04;
  const hullFill = f.hulls ? String(hullOp) : '0';
  const hullStroke = f.hulls ? '0.25' : '0';
  for (const [, he] of state.hullElements) {
    setAttrIfChanged(he.path, 'fill-opacity', hullFill, '_lastFillOp');
    setAttrIfChanged(he.path, 'stroke-opacity', hullStroke, '_lastStrokeOp');
  }

  const fLabOp = !f.clusterLabels ? 0
    : k < 0.7 ? 0.4 : k < 2.5 ? 0.7 : Math.max(0.2, 0.7 - (k - 2.5) * 0.7);
  const fFont = k <= 2 ? 13 / Math.max(0.3, k) : 13 / (2 * Math.pow(k / 2, 0.75));
  const fLabOpStr = String(fLabOp);
  const fFontStr = String(fFont);
  for (const [, text] of state.clusterLabelElements) {
    setAttrIfChanged(text, 'opacity', fLabOpStr, '_lastOp');
    setAttrIfChanged(text, 'font-size', fFontStr, '_lastFs');
  }

  const screenR = 5 * k;
  const labelOp = !f.labels ? 0
    : screenR < 6 ? 0 : Math.min(1, (screenR - 6) / 10);
  const labelFs = Math.max(2, Math.min(8, 7 / k));
  const labelOpStr = String(labelOp);
  const labelFsStr = String(labelFs);
  const labelsOff = !f.labels;
  for (const [, text] of state.labelElements) {
    setAttrIfChanged(text, 'opacity', labelOpStr, '_lastOp');
    if (!labelsOff) setAttrIfChanged(text, 'font-size', labelFsStr, '_lastFs');
  }

  const gMeta = state.svgCtx.layers.gMetaLinks;
  if (f.metaEdges && k < 1.5) {
    if (gMeta.style.display !== '') gMeta.style.display = '';
    const op = k < 0.3 ? 0.25 : k < 0.7 ? 0.45 : 0.6;
    setAttrIfChanged(gMeta, 'opacity', String(op), '_lastOp');
  } else if (gMeta.style.display !== 'none') {
    gMeta.style.display = 'none';
  }

  const gLinks = state.svgCtx.layers.gLinks;
  const linksDisplay = f.edges ? '' : 'none';
  if (gLinks.style.display !== linksDisplay) gLinks.style.display = linksDisplay;

  sig.k = k;
  sig.hulls = f.hulls; sig.labels = f.labels;
  sig.clusterLabels = f.clusterLabels; sig.metaEdges = f.metaEdges; sig.edges = f.edges;
  sig.nHulls = state.hullElements.size;
  sig.nClusterLabels = state.clusterLabelElements.size;
  sig.nLabels = state.labelElements.size;
}

// Epsilon for k-equality. Below this, re-derived zoom values are
// indistinguishable at integer-ish SVG attribute precision.
const K_EPS = 1e-4;

// Cache the last applied attribute value on the element. SVG setAttribute
// is the expensive step here (style recalc + paint); the branch is free.
function setAttrIfChanged(el, name, value, cacheKey) {
  if (el[cacheKey] === value) return;
  el.setAttribute(name, value);
  el[cacheKey] = value;
}

/* =====================================================================
 * Selection highlight
 * =================================================================== */

export function renderSelectionGlow(state, selection) {
  if (!state.svgCtx) return;
  for (const [id, circle] of state.nodeCircleElements) {
    const sel = selection && selection.selected && selection.selected.has(id);
    if (sel) {
      circle.setAttribute('stroke', '#ff0');
      circle.setAttribute('stroke-width', '2.5');
    } else {
      circle.setAttribute('stroke-width', '1.5');
    }
  }
}
