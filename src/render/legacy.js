/**
 * Legacy renderer — old_versions/index.html visuals ported onto the new
 * modular data shapes (graph.state, posMap, derivation).
 *
 * This deliberately bypasses render/fractal.js and the DOM-diffing block
 * inside main.js. It hand-rolls SVG the way the old monolith did so the
 * graph keeps the look the user is nostalgic for:
 *
 *   - per-cluster colors with a 20-color palette
 *   - proximity gradient edges (solid ends, faded middle when far)
 *   - secondary affinity ring around nodes with a strong second cluster
 *   - convex hull fills with textPath boundary labels
 *   - meta-edges between cluster centroids with gradient stops
 *   - floating cluster labels with force-based placement
 *   - semantic zoom: hulls fade, boundary labels appear, deep nodes fade in
 *
 * Entry points:
 *   createLegacyRenderer(svgCtx)            — one-time setup
 *   renderFull(state, deps)                 — full redraw (structure change)
 *   renderPositionsOnly(state, deps)        — per-frame endpoint/transform update
 *   applySemanticZoom(state, deps, k)       — zoom-driven opacity tweaks
 *   setShowFlag(state, name, value)
 *
 * @module render/legacy
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

/** Hash a cluster id to a stable palette index. */
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

/** Short pretty name for a cluster: strip the "cluster:" prefix. */
export function clusterShortName(clusterId) {
  if (!clusterId) return '?';
  return String(clusterId).replace(/^cluster:/, '');
}

/**
 * Node kind → base color. Used when a node has no cluster assignment.
 * Cluster colors take precedence when derivation groups the node.
 */
export function legacyNodeColor(kind) {
  const colors = {
    function: '#4a90d9',
    global:   '#e74c3c',
    module:   '#2ecc71',
    cluster:  '#9b59b6',
    parameter:'#f39c12',
    value:    '#1abc9c',
  };
  return colors[kind] || '#95a5a6';
}

/**
 * Node radius: importance + small boost for cluster-kind nodes.
 * Matches old `d.radius` semantics (the old used importance in [1..10]).
 */
function nodeRadius(node) {
  const imp = (node && node.importance != null) ? node.importance : 1;
  return 3 + Math.min(6, Math.sqrt(imp) * 2.2);
}

/** Convex hull expansion (old expandHull). */
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

/** Minimal convex hull (Andrew's monotone chain). 2+ points ok; returns null for <3. */
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

function hullPerimeter(pts) {
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    len += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return len;
}

function buildRepeatedLabel(name, perimeter, fontSize) {
  const charW = Math.max(1, fontSize) * 0.65;
  const sep = '  \u00b7  ';
  const unit = name + sep;
  const unitW = unit.length * charW;
  const reps = Math.max(1, Math.ceil(perimeter / Math.max(1, unitW)));
  return unit.repeat(reps);
}

/** Proximity-based mid-edge opacity (old edgeMidOpacity). */
function edgeMidOpacity(dist) {
  const CLOSE = 60, FAR = 250;
  if (dist <= CLOSE) return 1.0;
  if (dist >= FAR) return 0.08;
  return 1.0 - ((dist - CLOSE) / (FAR - CLOSE)) * 0.92;
}

/** Sanitize an edge id for safe use inside a url(#...) reference. */
function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Blend two hex colors at 0.5. */
function blendHex(a, b) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = (((pa >> 16) & 0xff) + ((pb >> 16) & 0xff)) >> 1;
  const g = (((pa >> 8) & 0xff) + ((pb >> 8) & 0xff)) >> 1;
  const bl = ((pa & 0xff) + (pb & 0xff)) >> 1;
  return '#' + ((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0');
}

/**
 * Create the legacy render state. Call once at init.
 * @param {import('./svg.js').SVGContext} svgCtx
 */
export function createLegacyRenderer(svgCtx) {
  return {
    svgCtx,
    // DOM element maps keyed by id
    nodeElements:      new Map(), // id -> <g class=node> (contains main circle + optional ring)
    nodeCircleElements:new Map(), // id -> <circle> (the main circle, for glow toggles)
    labelElements:     new Map(), // id -> <text>
    edgeElements:      new Map(), // edgeId -> <line>
    arrowElements:     new Map(), // edgeId -> <path>
    gradientElements:  new Map(), // edgeId -> { grad, stops[5], src, tgt }
    hullElements:      new Map(), // clusterId -> { path, text, textPath, pathDef }
    metaLinkElements:  new Map(), // "a\0b"  -> { line, grad, stops[5], color1, color2 }
    clusterLabelElements: new Map(), // clusterId -> <text>
    // Cluster/placement caches
    clusterIndex:      new Map(), // nodeId -> clusterId
    clusterMembers:    new Map(), // clusterId -> string[] (node ids)
    clusterLabelOffset:new Map(), // clusterId -> { dx, dy }
    // Show flags (driven by chrome)
    flags: {
      labels: true,
      hulls: true,
      clusterLabels: true,
      boundaryLabels: true,
      edges: true,
      metaEdges: true,
      affinityRings: true,
    },
    // Display positions — copied into posMap before each render pass so that
    // the smooth-motion lerp can be honored.
    displayPositions: new Map(),
    smoothMotion: false,
    currentK: 1,
  };
}

/** Toggle a show-flag on the legacy state. */
export function setShowFlag(state, name, value) {
  state.flags[name] = !!value;
}

/* =====================================================================
 * Full redraw — call when structure changes (nodes added/removed/clustered)
 * =================================================================== */

/**
 * @param {ReturnType<typeof createLegacyRenderer>} state
 * @param {{ graph, posMap, derivation, context, selection }} deps
 */
export function renderFull(state, deps) {
  const { graph, posMap, derivation } = deps;
  const { svgCtx } = state;
  if (!svgCtx) return;

  // Cache cluster index and members.
  state.clusterIndex = buildClusterIndex(derivation.clusters);
  state.clusterMembers = new Map();
  for (const [cid, cl] of derivation.clusters) {
    state.clusterMembers.set(cid, [...cl.members]);
  }

  renderEdgesDiff(state, graph, posMap);
  renderNodesDiff(state, graph, posMap, derivation);
  renderLabelsDiff(state, graph, posMap);
  renderHullsFull(state, graph, posMap);
  renderClusterLabelsFull(state, graph, posMap);
  renderMetaLinksFull(state, graph, posMap);

  applySemanticZoom(state, deps, state.currentK);
  renderSelectionGlow(state, deps.selection);
}

/* =====================================================================
 * Edges: diff-based, preserves gradient defs across renders
 * =================================================================== */

function renderEdgesDiff(state, graph, posMap) {
  const { svgCtx, edgeElements, arrowElements, gradientElements } = state;
  const gLinks = svgCtx.layers.gLinks;
  const defs = svgCtx.defs;
  const seen = new Set();

  for (const [id, edge] of graph.state.edges) {
    const layerDef = getLayer(edge.layer);
    // Skip edges whose layer is toggled off — the edge will be GC'd below.
    if (layerDef && layerDef.visible === false) continue;
    const ps = posMap.positions.get(edge.source);
    const pt = posMap.positions.get(edge.target);
    if (!ps || !pt) continue;
    seen.add(id);

    const color = layerDef ? layerDef.color : '#4a9eff';
    const isDirected = !!(layerDef && layerDef.directed);

    // Gradient def (reused)
    let grad = gradientElements.get(id);
    if (!grad) {
      const gradEl = document.createElementNS(SVG_NS, 'linearGradient');
      gradEl.setAttribute('id', `edge-grad-${cssId(id)}`);
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
      grad = { grad: gradEl, stops, src: edge.source, tgt: edge.target, color };
      gradientElements.set(id, grad);
    } else if (grad.color !== color) {
      for (const s of grad.stops) s.setAttribute('stop-color', color);
      grad.color = color;
    }
    grad.src = edge.source;
    grad.tgt = edge.target;
    updateGradient(grad, ps.x, ps.y, pt.x, pt.y);

    // The <line>
    let line = edgeElements.get(id);
    if (!line) {
      line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'link');
      line.setAttribute('data-id', id);
      gLinks.appendChild(line);
      edgeElements.set(id, line);
    }
    line.setAttribute('data-source', edge.source);
    line.setAttribute('data-target', edge.target);
    line.setAttribute('x1', ps.x);
    line.setAttribute('y1', ps.y);
    line.setAttribute('x2', pt.x);
    line.setAttribute('y2', pt.y);
    line.setAttribute('stroke', `url(#${grad.grad.getAttribute('id')})`);
    const deg = Math.max(
      degreeOf(graph, edge.source),
      degreeOf(graph, edge.target),
    );
    const width = Math.min(3, (0.5 + (edge.weight || 1) * 0.3) / Math.max(1, Math.sqrt(deg) * 0.4));
    line.setAttribute('stroke-width', width);
    line.setAttribute('stroke-opacity', '0.85');
    if (layerDef && layerDef.dash) line.setAttribute('stroke-dasharray', layerDef.dash);
    else line.removeAttribute('stroke-dasharray');

    // Arrowhead for directed edges
    if (isDirected) {
      let arrow = arrowElements.get(id);
      if (!arrow) {
        arrow = document.createElementNS(SVG_NS, 'path');
        arrow.setAttribute('class', 'arrow');
        arrow.setAttribute('data-id', id);
        gLinks.appendChild(arrow);
        arrowElements.set(id, arrow);
      }
      updateArrow(arrow, ps.x, ps.y, pt.x, pt.y);
      arrow.setAttribute('fill', color);
      arrow.setAttribute('fill-opacity', '0.85');
    } else if (arrowElements.has(id)) {
      arrowElements.get(id).remove();
      arrowElements.delete(id);
    }
  }

  // Remove stale
  for (const [id, el] of edgeElements) {
    if (!seen.has(id)) {
      el.remove();
      edgeElements.delete(id);
      const g = gradientElements.get(id);
      if (g) { g.grad.remove(); gradientElements.delete(id); }
      const a = arrowElements.get(id);
      if (a) { a.remove(); arrowElements.delete(id); }
    }
  }
}

function degreeOf(graph, nodeId) {
  // Cheap lookup — edges is a Map and we only care for edge width.
  // The old version cached nodeDegree; here we scan once per render.
  if (!graph._cachedDegree) graph._cachedDegree = new Map();
  // Invalidate when edge count changes.
  if (graph._cachedDegreeSize !== graph.state.edges.size) {
    graph._cachedDegree.clear();
    for (const [, e] of graph.state.edges) {
      graph._cachedDegree.set(e.source, (graph._cachedDegree.get(e.source) || 0) + 1);
      graph._cachedDegree.set(e.target, (graph._cachedDegree.get(e.target) || 0) + 1);
    }
    graph._cachedDegreeSize = graph.state.edges.size;
  }
  return graph._cachedDegree.get(nodeId) || 1;
}

function updateGradient(grad, sx, sy, tx, ty) {
  grad.grad.setAttribute('x1', sx);
  grad.grad.setAttribute('y1', sy);
  grad.grad.setAttribute('x2', tx);
  grad.grad.setAttribute('y2', ty);
  const dist = Math.hypot(tx - sx, ty - sy);
  const midOp = edgeMidOpacity(dist);
  grad.stops[0].setAttribute('stop-opacity', '1');
  grad.stops[1].setAttribute('stop-opacity', String(midOp));
  grad.stops[2].setAttribute('stop-opacity', String(midOp * 0.7));
  grad.stops[3].setAttribute('stop-opacity', String(midOp));
  grad.stops[4].setAttribute('stop-opacity', '1');
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
 * Nodes: main circle + optional secondary affinity ring
 * =================================================================== */

function renderNodesDiff(state, graph, posMap, derivation) {
  const { svgCtx, nodeElements, nodeCircleElements, clusterIndex } = state;
  const gNodes = svgCtx.layers.gNodes;
  const seen = new Set();

  for (const [id, node] of graph.state.nodes) {
    const ps = posMap.positions.get(id);
    if (!ps) continue;
    seen.add(id);

    const cid = clusterIndex.get(id);
    const baseColor = cid ? clusterColor(cid) : legacyNodeColor(node.kind);
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

    // Main circle (first child)
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

    // Secondary affinity ring — only when the node's 2nd-strongest affinity
    // is a real peak (>= 0.15). Old behavior from old_versions:3606.
    if (state.flags.affinityRings) {
      const aff = derivation.affinities.get(id);
      let secondCid = null, secondWeight = 0;
      if (aff && aff.size >= 2) {
        const sorted = [...aff.entries()].sort((a, b) => b[1] - a[1]);
        if (sorted[1] && sorted[1][1] >= 0.15) {
          secondCid = sorted[1][0];
          secondWeight = sorted[1][1];
        }
      }

      let ring = g.querySelector('.affinity-ring');
      if (secondCid) {
        if (!ring) {
          ring = document.createElementNS(SVG_NS, 'circle');
          ring.setAttribute('class', 'affinity-ring');
          ring.setAttribute('fill', 'none');
          ring.setAttribute('pointer-events', 'none');
          g.appendChild(ring);
        }
        // secondCid from affinities is a *group* id — usually a clusterId, but
        // may be a raw node id on the first pass. Either way clusterColor is
        // stable under its string form.
        ring.setAttribute('r', r + 2.5);
        ring.setAttribute('stroke', clusterColor(secondCid));
        ring.setAttribute('stroke-width', String(Math.max(1, secondWeight * 4)));
        ring.setAttribute('stroke-opacity', String(0.4 + secondWeight * 0.6));
      } else if (ring) {
        ring.remove();
      }
    }
  }

  for (const [id, el] of nodeElements) {
    if (!seen.has(id)) {
      el.remove();
      nodeElements.delete(id);
      nodeCircleElements.delete(id);
    }
  }
}

function brighten(hex, amount) {
  const p = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((p >> 16) & 0xff) * (1 + amount)));
  const g = Math.min(255, Math.round(((p >> 8) & 0xff) * (1 + amount)));
  const b = Math.min(255, Math.round((p & 0xff) * (1 + amount)));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

/* =====================================================================
 * Labels
 * =================================================================== */

function renderLabelsDiff(state, graph, posMap) {
  const { svgCtx, labelElements } = state;
  const gLabels = svgCtx.layers.gLabels;
  const seen = new Set();

  for (const [id, node] of graph.state.nodes) {
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
      gLabels.appendChild(text);
      labelElements.set(id, text);
    }
    text.setAttribute('x', ps.x);
    text.setAttribute('y', ps.y);
    if (text.textContent !== (node.label || id)) text.textContent = node.label || id;
  }

  for (const [id, el] of labelElements) {
    if (!seen.has(id)) { el.remove(); labelElements.delete(id); }
  }
}

/* =====================================================================
 * Hulls with textPath boundary labels
 * =================================================================== */

function renderHullsFull(state, graph, posMap) {
  const { svgCtx, hullElements, clusterMembers } = state;
  const gHulls = svgCtx.layers.gHulls;
  const defs = svgCtx.defs;
  const seen = new Set();

  for (const [cid, members] of clusterMembers) {
    if (!members || members.length < 3) continue;
    const pts = [];
    for (const mid of members) {
      const p = posMap.positions.get(mid);
      if (p) pts.push([p.x, p.y]);
    }
    if (pts.length < 3) continue;
    const hull = convexHull(pts);
    if (!hull || hull.length < 3) continue;
    const expanded = expandHull(hull, 20);
    const pathD = `M${expanded.map(p => p.join(',')).join('L')}Z`;
    const pathId = `hull-path-${cssId(cid)}`;
    const color = clusterColor(cid);

    let he = hullElements.get(cid);
    if (!he) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'hull');
      path.setAttribute('fill', color);
      path.setAttribute('stroke', color);
      path.setAttribute('fill-opacity', '0.08');
      path.setAttribute('stroke-opacity', '0.25');
      path.setAttribute('stroke-width', '1.5');
      gHulls.appendChild(path);

      const pathDef = document.createElementNS(SVG_NS, 'path');
      pathDef.setAttribute('id', pathId);
      pathDef.setAttribute('class', 'hull-path-def');
      defs.appendChild(pathDef);

      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'hull-label');
      text.setAttribute('fill', color);
      text.setAttribute('fill-opacity', '0');
      text.setAttribute('font-size', '10');
      text.setAttribute('letter-spacing', '2');
      text.setAttribute('font-weight', '600');
      const textPath = document.createElementNS(SVG_NS, 'textPath');
      textPath.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${pathId}`);
      textPath.setAttribute('href', `#${pathId}`);
      text.appendChild(textPath);
      gHulls.appendChild(text);

      he = { path, pathDef, text, textPath, pathId };
      hullElements.set(cid, he);
    }
    he.path.setAttribute('d', pathD);
    he.pathDef.setAttribute('d', pathD);
    const name = clusterShortName(cid);
    const perim = hullPerimeter(expanded);
    const label = buildRepeatedLabel(name, perim, 10);
    if (he.textPath.textContent !== label) he.textPath.textContent = label;
    seen.add(cid);
  }

  for (const [cid, he] of hullElements) {
    if (!seen.has(cid)) {
      he.path.remove();
      he.pathDef.remove();
      he.text.remove();
      hullElements.delete(cid);
    }
  }
}

/* =====================================================================
 * Floating cluster labels
 * =================================================================== */

function renderClusterLabelsFull(state, graph, posMap) {
  const { svgCtx, clusterLabelElements, clusterMembers, clusterLabelOffset } = state;
  const gClusterLabels = svgCtx.layers.gClusterLabels;
  const seen = new Set();

  for (const [cid, members] of clusterMembers) {
    if (!members || members.length === 0) continue;
    let cx = 0, cy = 0, n = 0;
    let minY = Infinity;
    for (const mid of members) {
      const p = posMap.positions.get(mid);
      if (!p) continue;
      cx += p.x; cy += p.y; n++;
      if (p.y < minY) minY = p.y;
    }
    if (n === 0) continue;
    cx /= n; cy /= n;
    if (!clusterLabelOffset.has(cid)) {
      clusterLabelOffset.set(cid, { dx: 0, dy: (minY - 18) - cy });
    }
    const off = clusterLabelOffset.get(cid);
    seen.add(cid);

    let text = clusterLabelElements.get(cid);
    if (!text) {
      // Use a <g> wrapper so the invisible hit-rect and visible text share
      // the same data-cluster attribute for event delegation.
      text = document.createElementNS(SVG_NS, 'g');
      text.setAttribute('class', 'cluster-label');
      text.setAttribute('data-cluster', cid);
      text.style.cursor = 'grab';

      // Invisible backing rect — makes the hit area the full bounding box
      // instead of just the visible glyphs. Sized after first paint.
      const hitRect = document.createElementNS(SVG_NS, 'rect');
      hitRect.setAttribute('fill', 'transparent');
      hitRect.setAttribute('rx', '4');
      text.appendChild(hitRect);
      text._hitRect = hitRect;

      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.setAttribute('font-weight', '600');
      label.setAttribute('fill', clusterColor(cid));
      label.setAttribute('fill-opacity', '0.6');
      label.textContent = clusterShortName(cid);
      text.appendChild(label);
      text._label = label;

      gClusterLabels.appendChild(text);
      clusterLabelElements.set(cid, text);
    }
    text.setAttribute('transform', `translate(${cx + off.dx},${cy + off.dy})`);

    // Size the hit rect to match the text bounding box (+ padding).
    if (text._hitRect && text._label) {
      const bbox = text._label.getBBox();
      const pad = 6;
      text._hitRect.setAttribute('x', bbox.x - pad);
      text._hitRect.setAttribute('y', bbox.y - pad);
      text._hitRect.setAttribute('width', bbox.width + pad * 2);
      text._hitRect.setAttribute('height', bbox.height + pad * 2);
    }
  }

  for (const [cid, el] of clusterLabelElements) {
    if (!seen.has(cid)) {
      el.remove();
      clusterLabelElements.delete(cid);
    }
  }
}

/* =====================================================================
 * Meta-edges between cluster centroids
 * =================================================================== */

function clusterCentroid(state, posMap, cid) {
  const members = state.clusterMembers.get(cid);
  if (!members || members.length === 0) return { x: 0, y: 0 };
  let cx = 0, cy = 0, n = 0;
  for (const mid of members) {
    const p = posMap.positions.get(mid);
    if (!p) continue;
    cx += p.x; cy += p.y; n++;
  }
  if (!n) return { x: 0, y: 0 };
  return { x: cx / n, y: cy / n };
}

function renderMetaLinksFull(state, graph, posMap) {
  const { svgCtx, metaLinkElements } = state;
  const gMeta = svgCtx.layers.gMetaLinks;
  const defs = svgCtx.defs;

  // Tally inter-cluster coupling.
  const coupling = new Map();
  for (const [, edge] of graph.state.edges) {
    const ca = state.clusterIndex.get(edge.source);
    const cb = state.clusterIndex.get(edge.target);
    if (!ca || !cb || ca === cb) continue;
    const [a, b] = ca < cb ? [ca, cb] : [cb, ca];
    const key = a + '\0' + b;
    coupling.set(key, (coupling.get(key) || 0) + (edge.weight || 1));
  }
  const maxCoupling = Math.max(1, ...coupling.values());
  const seen = new Set();
  for (const [key, w] of coupling) {
    const [a, b] = key.split('\0');
    const s = clusterCentroid(state, posMap, a);
    const t = clusterCentroid(state, posMap, b);
    const nw = w / maxCoupling;
    const c1 = clusterColor(a);
    const c2 = clusterColor(b);
    const blended = blendHex(c1, c2);

    let ml = metaLinkElements.get(key);
    if (!ml) {
      const grad = document.createElementNS(SVG_NS, 'linearGradient');
      grad.setAttribute('class', 'meta-grad');
      grad.setAttribute('id', `meta-grad-${cssId(key)}`);
      grad.setAttribute('gradientUnits', 'userSpaceOnUse');
      const ops = [0.7, 0.12, 0.05, 0.08, 0.7];
      const cols = [c1, blended, blended, blended, c2];
      const stops = [];
      for (let i = 0; i < 5; i++) {
        const stop = document.createElementNS(SVG_NS, 'stop');
        stop.setAttribute('offset', (i * 25) + '%');
        stop.setAttribute('stop-color', cols[i]);
        stop.setAttribute('stop-opacity', String(ops[i]));
        grad.appendChild(stop);
        stops.push(stop);
      }
      defs.appendChild(grad);

      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'meta-link');
      line.setAttribute('stroke', `url(#${grad.getAttribute('id')})`);
      line.setAttribute('stroke-linecap', 'round');
      gMeta.appendChild(line);

      ml = { line, grad, stops, c1, c2 };
      metaLinkElements.set(key, ml);
    }
    ml.line.setAttribute('x1', s.x);
    ml.line.setAttribute('y1', s.y);
    ml.line.setAttribute('x2', t.x);
    ml.line.setAttribute('y2', t.y);
    ml.line.setAttribute('stroke-width', String(0.5 + nw * 4));
    ml.grad.setAttribute('x1', s.x);
    ml.grad.setAttribute('y1', s.y);
    ml.grad.setAttribute('x2', t.x);
    ml.grad.setAttribute('y2', t.y);
    seen.add(key);
  }
  for (const [key, ml] of metaLinkElements) {
    if (!seen.has(key)) {
      ml.line.remove();
      ml.grad.remove();
      metaLinkElements.delete(key);
    }
  }
}

/* =====================================================================
 * Selection / trace glow
 * =================================================================== */

export function renderSelectionGlow(state, selection) {
  if (!state.svgCtx) return;
  for (const [id, circle] of state.nodeCircleElements) {
    const sel = selection && selection.selected && selection.selected.has(id);
    circle.classList.toggle('selected-glow', !!sel);
    if (sel) {
      circle.setAttribute('stroke', '#ff0');
      circle.setAttribute('stroke-width', '2.5');
    } else {
      // Restore default stroke — caller must trigger renderFull to re-color.
      circle.setAttribute('stroke-width', '1.5');
    }
  }
}

/* =====================================================================
 * Per-frame position update (render pump)
 * =================================================================== */

export function renderPositionsOnly(state, deps) {
  const { posMap } = deps;
  if (!state.svgCtx) return;

  const display = state.displayPositions;
  const smooth = !!state.smoothMotion;
  const LERP = 0.18;

  // Nodes
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
    g.setAttribute('transform', `translate(${dp.x},${dp.y})`);
  }

  // Labels
  for (const [id, text] of state.labelElements) {
    const dp = display.get(id);
    if (!dp) continue;
    text.setAttribute('x', dp.x);
    text.setAttribute('y', dp.y);
  }

  // Edges — update endpoints + gradient stops
  for (const [id, line] of state.edgeElements) {
    const sid = line.getAttribute('data-source');
    const tid = line.getAttribute('data-target');
    const ds = display.get(sid) || posMap.positions.get(sid);
    const dt = display.get(tid) || posMap.positions.get(tid);
    if (!ds || !dt) continue;
    line.setAttribute('x1', ds.x); line.setAttribute('y1', ds.y);
    line.setAttribute('x2', dt.x); line.setAttribute('y2', dt.y);
    const grad = state.gradientElements.get(id);
    if (grad) updateGradient(grad, ds.x, ds.y, dt.x, dt.y);
    const arrow = state.arrowElements.get(id);
    if (arrow) updateArrow(arrow, ds.x, ds.y, dt.x, dt.y);
  }

  // Meta-edges: follow cluster centroids via member display positions.
  for (const [key, ml] of state.metaLinkElements) {
    const [a, b] = key.split('\0');
    const s = centroidFromDisplay(state, a);
    const t = centroidFromDisplay(state, b);
    ml.line.setAttribute('x1', s.x); ml.line.setAttribute('y1', s.y);
    ml.line.setAttribute('x2', t.x); ml.line.setAttribute('y2', t.y);
    ml.grad.setAttribute('x1', s.x); ml.grad.setAttribute('y1', s.y);
    ml.grad.setAttribute('x2', t.x); ml.grad.setAttribute('y2', t.y);
  }

  // Hulls & cluster labels — structure-dependent, but positions drift every
  // frame while dragging, so rebuild paths from display positions.
  rebuildHullPaths(state);
  positionClusterLabelsFromDisplay(state);
}

function centroidFromDisplay(state, cid) {
  const members = state.clusterMembers.get(cid);
  if (!members || members.length === 0) return { x: 0, y: 0 };
  let cx = 0, cy = 0, n = 0;
  for (const mid of members) {
    const dp = state.displayPositions.get(mid);
    if (!dp) continue;
    cx += dp.x; cy += dp.y; n++;
  }
  if (!n) return { x: 0, y: 0 };
  return { x: cx / n, y: cy / n };
}

function rebuildHullPaths(state) {
  for (const [cid, he] of state.hullElements) {
    const members = state.clusterMembers.get(cid);
    if (!members) continue;
    const pts = [];
    for (const mid of members) {
      const dp = state.displayPositions.get(mid);
      if (dp) pts.push([dp.x, dp.y]);
    }
    if (pts.length < 3) continue;
    const hull = convexHull(pts);
    if (!hull || hull.length < 3) continue;
    const expanded = expandHull(hull, 20);
    const d = `M${expanded.map(p => p.join(',')).join('L')}Z`;
    he.path.setAttribute('d', d);
    he.pathDef.setAttribute('d', d);
  }
}

function positionClusterLabelsFromDisplay(state) {
  for (const [cid, text] of state.clusterLabelElements) {
    const members = state.clusterMembers.get(cid);
    if (!members) continue;
    let cx = 0, cy = 0, n = 0;
    for (const mid of members) {
      const dp = state.displayPositions.get(mid);
      if (!dp) continue;
      cx += dp.x; cy += dp.y; n++;
    }
    if (!n) continue;
    cx /= n; cy /= n;
    const off = state.clusterLabelOffset.get(cid) || { dx: 0, dy: -30 };
    text.setAttribute('transform', `translate(${cx + off.dx},${cy + off.dy})`);
  }
}

/* =====================================================================
 * Semantic zoom — hulls fade, boundary labels fade in, deep nodes fade in
 * =================================================================== */

export function applySemanticZoom(state, deps, k) {
  if (!state.svgCtx) return;
  state.currentK = k;

  // Hulls: fill opacity depends on zoom (more subtle when zoomed in)
  const hullOp = k < 0.5 ? 0.15 : k < 1.5 ? 0.08 : 0.04;
  for (const [, he] of state.hullElements) {
    if (state.flags.hulls) {
      he.path.setAttribute('fill-opacity', String(hullOp));
      he.path.setAttribute('stroke-opacity', '0.25');
    } else {
      he.path.setAttribute('fill-opacity', '0');
      he.path.setAttribute('stroke-opacity', '0');
    }
  }

  // Boundary textPath labels: fade in from k=3, full at k=4.5
  const bpOp = !state.flags.boundaryLabels ? 0
    : Math.min(0.45, Math.max(0, (k - 3) * 0.45));
  const bpFont = Math.max(2, Math.min(6, 5 / Math.max(0.3, k)));
  for (const [, he] of state.hullElements) {
    he.text.setAttribute('fill-opacity', String(bpOp));
    he.text.setAttribute('font-size', String(bpFont));
  }

  // Floating cluster labels: fade out as textPath labels fade in
  const fLabOp = !state.flags.clusterLabels ? 0
    : k < 0.7 ? 0.4 : k < 2.5 ? 0.7 : Math.max(0.2, 0.7 - (k - 2.5) * 0.7);
  const fFont = k <= 2 ? 13 / Math.max(0.3, k) : 13 / (2 * Math.pow(k / 2, 0.75));
  for (const [, text] of state.clusterLabelElements) {
    text.setAttribute('opacity', String(fLabOp));
    // font-size goes on the inner <text>, not the <g> wrapper.
    const labelEl = text._label || text;
    labelEl.setAttribute('font-size', String(fFont));
  }

  // Node labels: fade in only when the node is big enough on screen
  for (const [id, text] of state.labelElements) {
    if (!state.flags.labels) { text.setAttribute('opacity', '0'); continue; }
    // Use a constant base font so on-screen size is consistent across zooms.
    const screenR = 5 * k;
    const opacity = screenR < 6 ? 0 : Math.min(1, (screenR - 6) / 10);
    text.setAttribute('opacity', String(opacity));
    const fs = Math.max(2, Math.min(8, 7 / k));
    text.setAttribute('font-size', String(fs));
  }

  // Meta-edges: visible when zoomed out.
  const gMeta = state.svgCtx.layers.gMetaLinks;
  if (state.flags.metaEdges && k < 1.5) {
    gMeta.style.display = '';
    const op = k < 0.3 ? 0.25 : k < 0.7 ? 0.45 : 0.6;
    gMeta.setAttribute('opacity', String(op));
  } else {
    gMeta.style.display = 'none';
  }

  // Individual edges: toggle via flag.
  const gLinks = state.svgCtx.layers.gLinks;
  gLinks.style.display = state.flags.edges ? '' : 'none';
}
