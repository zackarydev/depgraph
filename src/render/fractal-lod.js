/**
 * Fractal level classification + visual LOD.
 *
 * The per-tier display:none model has been superseded by render-rules.js,
 * which classifies elements by class (kind, layer, cluster-target-or-not)
 * and applies continuous opacity ramps based on zoom. The whole document
 * outline coexists at LOD A; leaf content (text labels, pixel circles,
 * lattice edges) reveals at LOD B as the user zooms in.
 *
 * computeFractalLevels stays useful: it produces the cluster-target set the
 * rules engine needs to classify "structural" vs "leaf" nodes. The depth
 * (level) field is still computed for any future depth-aware rule but is
 * no longer the primary visibility gate.
 *
 * @module render/fractal-lod
 */

import { applyRenderRules } from './render-rules.js';

/**
 * Pixel-grid kinds bypass the cluster-chain entirely. Their affinity
 * cluster (cluster:img:meta — or, during streaming, transient
 * cluster:px:foo chains) is an artifact of the affinity falloff, not real
 * hierarchy. Pinning them at level 0 and excluding them from clusterTargets
 * keeps a partially-loaded image rendering coherently.
 */
const IMAGE_KINDS = new Set(['pixel', 'image-header']);

/**
 * Legacy thresholds kept for any caller that still wants a deepest-relevant
 * level. The rules engine doesn't consult them.
 */
export const LEVEL_THRESHOLDS = [0, 1.5, 3.0, 6.0];

/**
 * Deepest level whose threshold has been crossed at zoom k. Legacy helper.
 * @param {number} k
 * @returns {number}
 */
export function currentMaxLevel(k) {
  let lvl = 0;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (k >= LEVEL_THRESHOLDS[i]) lvl = i;
    else break;
  }
  return lvl;
}

/**
 * Compute the fractal level of every node and the set of cluster-target
 * nodes (nodes that have a derived `cluster:<id>` entry — they collapse to
 * a single node when their cluster isn't expanded).
 *
 * Roots (cluster targets that aren't members of any other cluster) are
 * level 0. A member of a root cluster is level 1, a member of a level-1
 * cluster is level 2, and so on. Image-grid nodes are pinned at level 0
 * and excluded from clusterTargets so transient streaming clusters don't
 * misclassify pixels as structural.
 *
 * @param {Map<string, import('../core/types.js').Cluster>} clusters
 * @param {Map<string, import('../core/types.js').Node>} nodes
 * @returns {{ levels: Map<string, number>, clusterTargets: Set<string>, maxLevel: number }}
 */
export function computeFractalLevels(clusters, nodes) {
  const memberToCluster = new Map();
  for (const [cid, c] of clusters) {
    for (const m of c.members) memberToCluster.set(m, cid);
  }

  const clusterTargets = new Set();
  for (const cid of clusters.keys()) {
    const target = cid.replace(/^(cluster:)+/, '');
    const tn = nodes.get(target);
    if (tn && IMAGE_KINDS.has(tn.kind)) continue;
    clusterTargets.add(target);
  }

  const levels = new Map();
  const VISITING = -1;
  let maxLevel = 0;
  function levelOf(id) {
    const cached = levels.get(id);
    if (cached === VISITING) return 0;
    if (cached != null) return cached;
    const node = nodes.get(id);
    if (node && IMAGE_KINDS.has(node.kind)) {
      levels.set(id, 0);
      return 0;
    }
    const parentClusterId = memberToCluster.get(id);
    if (!parentClusterId) {
      levels.set(id, 0);
      return 0;
    }
    levels.set(id, VISITING);
    const parentTarget = parentClusterId.replace(/^(cluster:)+/, '');
    const parentLevel = parentTarget === id ? 0 : levelOf(parentTarget);
    const lvl = parentLevel + 1;
    levels.set(id, lvl);
    if (lvl > maxLevel) maxLevel = lvl;
    return lvl;
  }
  for (const id of nodes.keys()) levelOf(id);

  return { levels, clusterTargets, maxLevel };
}

/**
 * Apply visual LOD by running the render-rules engine. Replaces the old
 * per-tier display toggling with continuous opacity ramps. Signature kept
 * stable for existing callers (main.js zoom handler, v3.js renderFull).
 *
 * @param {Object} state - v3 renderer state
 * @param {Object} deps - { graph, ... }
 * @param {number} k - current zoom scale
 */
export function applyFractalLod(state, deps, k) {
  applyRenderRules(state, deps, k);
  applyFractalLayerFilter(state, deps);
}

/**
 * Discrete fractal-layer visibility filter, independent of zoom k.
 *
 * Hides nodes at deeper levels than the active layer, and collapses cluster
 * targets at shallower levels (so their members render in their place).
 * Layer = Infinity (the default) is a no-op and preserves k-driven rendering.
 *
 * Stored on `state.fractalLayer`. The render-rules pass runs first; this
 * pass overrides display:none for nodes/edges/labels that fall outside the
 * active layer. The cache key (`_layerDisp`) is distinct from the
 * render-rules cache (`_lodDisp`) so the two passes don't fight each other
 * at idempotency time.
 *
 * @param {Object} state - v3 renderer state
 */
export function applyFractalLayerFilter(state, deps) {
  const layer = state.fractalLayer;
  if (layer == null || !isFinite(layer)) {
    // Reset any prior overrides so a previous filter doesn't leak.
    for (const [, g] of state.nodeElements || []) clearLayerHide(g);
    for (const [, t] of state.labelElements || []) {
      clearLayerHide(t);
      clearLabelOpacityOverride(t);
    }
    for (const [, line] of state.edgeElements || []) clearLayerHide(line);
    if (state.arrowElements) for (const [, a] of state.arrowElements) clearLayerHide(a);
    if (state.hullElements) for (const [, he] of state.hullElements) clearLayerHide(he.path);
    if (state.clusterLabelElements) for (const [, t] of state.clusterLabelElements) clearLayerHide(t);
    return;
  }
  const fl = state.fractalLod;
  if (!fl) return;
  const { levels, clusterTargets } = fl;

  function visibleByLayer(id) {
    const lvl = levels.get(id);
    if (lvl == null) return true;
    if (lvl > layer) return false;
    if (lvl < layer && clusterTargets.has(id)) return false;
    return true;
  }

  for (const [id, g] of state.nodeElements) {
    setLayerHide(g, !visibleByLayer(id));
  }
  for (const [id, t] of state.labelElements) {
    const vis = visibleByLayer(id);
    setLayerHide(t, !vis);
    // applySemanticZoom fades labels by screen-radius; under a fractal-layer
    // filter the surviving nodes are stand-ins for whole subtrees and must
    // stay readable regardless of how small they look on screen.
    if (vis) setLabelOpacityOverride(t, '1');
    else clearLabelOpacityOverride(t);
  }
  const edges = deps && deps.graph ? deps.graph.state.edges : null;
  for (const [key, line] of state.edgeElements) {
    let hide = false;
    if (key.startsWith('e:') && edges) {
      const edge = edges.get(key.slice(2));
      if (edge) hide = !visibleByLayer(edge.source) || !visibleByLayer(edge.target);
    }
    setLayerHide(line, hide);
    const arrow = state.arrowElements && state.arrowElements.get(key);
    if (arrow) setLayerHide(arrow, hide);
  }
  if (state.hullElements) {
    for (const [cid, he] of state.hullElements) {
      const target = cid.replace(/^(cluster:)+/, '');
      const targetLvl = levels.get(target);
      const expanded = targetLvl != null && targetLvl < layer;
      setLayerHide(he.path, !expanded);
    }
  }
  if (state.clusterLabelElements) {
    for (const [cid, t] of state.clusterLabelElements) {
      const target = cid.replace(/^(cluster:)+/, '');
      const targetLvl = levels.get(target);
      const expanded = targetLvl != null && targetLvl < layer;
      setLayerHide(t, !expanded);
    }
  }
}

function setLayerHide(el, hide) {
  const v = hide ? 'none' : '';
  if (el._layerDisp === v) return;
  // Don't clobber render-rules' display:none — only force-hide on top of it.
  if (!hide && el._lodDisp === 'none') {
    el._layerDisp = v;
    return;
  }
  el.style.display = v;
  el._layerDisp = v;
}

function clearLayerHide(el) {
  if (el._layerDisp == null) return;
  // Re-defer to whatever render-rules wants.
  el.style.display = el._lodDisp === 'none' ? 'none' : '';
  el._layerDisp = null;
}

function setLabelOpacityOverride(el, value) {
  if (el._layerLabelOp === value) return;
  el.setAttribute('opacity', value);
  el._layerLabelOp = value;
}

function clearLabelOpacityOverride(el) {
  if (el._layerLabelOp == null) return;
  // Don't restore a specific value — applySemanticZoom will reapply on the
  // next zoom event. Leaving the attribute at the override value until then
  // is acceptable; the next zoom will normalize it.
  el._layerLabelOp = null;
}

/**
 * Build a human-auditable export of the current fractal layer hierarchy.
 * Returns the same `levels` / `clusterTargets` data computeFractalLevels
 * produces, but reorganized into:
 *   - `tree`: nested cluster-target → members (recursive)
 *   - `byLevel`: flat per-level listings
 *   - `summary`: counts per level, isolated-node count, max depth
 *   - `markdown`: a printable indented outline
 *
 * Use this to diagnose whether the cluster structure is doing something
 * sensible — orphans, depth distribution, whether image/pixel grids leak
 * into structural levels, etc.
 *
 * @param {Map<string, import('../core/types.js').Cluster>} clusters
 * @param {Map<string, import('../core/types.js').Node>} nodes
 * @returns {{ tree: Array, byLevel: Object, summary: Object, markdown: string, raw: Object }}
 */
export function exportFractalLayers(clusters, nodes, hyperEdges) {
  const { levels, clusterTargets, maxLevel } = computeFractalLevels(clusters, nodes);

  // Map cluster-target → direct member node ids (excluding the target itself).
  const targetToMembers = new Map();
  for (const [cid, c] of clusters) {
    const target = cid.replace(/^(cluster:)+/, '');
    if (!clusterTargets.has(target)) continue;
    const members = [];
    for (const m of c.members) if (m !== target) members.push(m);
    targetToMembers.set(target, members);
  }

  // A node is a child-of relation only if it lives in another cluster's member
  // set. Roots = cluster targets at level 0, plus level-0 nodes that aren't
  // members of anything (orphans).
  const memberToParent = new Map();
  for (const [cid, c] of clusters) {
    const parent = cid.replace(/^(cluster:)+/, '');
    if (!clusterTargets.has(parent)) continue;
    for (const m of c.members) {
      if (m === parent) continue;
      // First parent wins; in practice each member has at most one cluster.
      if (!memberToParent.has(m)) memberToParent.set(m, parent);
    }
  }

  function describe(id) {
    const n = nodes.get(id);
    return {
      id,
      kind: n ? n.kind : 'unknown',
      label: n ? n.label : id,
      level: levels.get(id) ?? 0,
      isClusterTarget: clusterTargets.has(id),
    };
  }

  const seen = new Set();
  function buildSubtree(id) {
    if (seen.has(id)) return { ...describe(id), cycle: true, children: [] };
    seen.add(id);
    const node = describe(id);
    const memberIds = targetToMembers.get(id) || [];
    const children = memberIds
      .map(m => buildSubtree(m))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { ...node, children };
  }

  const roots = [];
  for (const id of nodes.keys()) {
    if (memberToParent.has(id)) continue;
    roots.push(buildSubtree(id));
  }
  roots.sort((a, b) => {
    if (a.isClusterTarget !== b.isClusterTarget) return a.isClusterTarget ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const byLevel = {};
  for (let i = 0; i <= maxLevel; i++) byLevel[i] = [];
  for (const id of nodes.keys()) {
    const lvl = levels.get(id) ?? 0;
    if (!byLevel[lvl]) byLevel[lvl] = [];
    byLevel[lvl].push(describe(id));
  }
  for (const k of Object.keys(byLevel)) byLevel[k].sort((a, b) => a.id.localeCompare(b.id));

  const orphans = roots.filter(r => !r.isClusterTarget && r.children.length === 0).length;
  const summary = {
    totalNodes: nodes.size,
    totalClusters: clusters.size,
    totalClusterTargets: clusterTargets.size,
    maxLevel,
    countsPerLevel: Object.fromEntries(
      Object.entries(byLevel).map(([k, v]) => [k, v.length]),
    ),
    rootCount: roots.length,
    orphanCount: orphans,
  };

  const lines = [];
  lines.push(`# Fractal Layers`);
  lines.push('');
  lines.push(`- nodes: ${summary.totalNodes}`);
  lines.push(`- clusters: ${summary.totalClusters} (cluster-targets: ${summary.totalClusterTargets})`);
  lines.push(`- max level: ${summary.maxLevel}`);
  lines.push(`- roots: ${summary.rootCount} (orphan leaves at root: ${summary.orphanCount})`);
  lines.push('');
  lines.push(`## Counts per level`);
  for (const [k, v] of Object.entries(summary.countsPerLevel)) {
    lines.push(`- L${k}: ${v}`);
  }
  lines.push('');
  lines.push(`## Tree`);
  function emit(node, depth) {
    const indent = '  '.repeat(depth);
    const tag = node.isClusterTarget ? '▼' : '·';
    const cycle = node.cycle ? ' [cycle]' : '';
    lines.push(`${indent}${tag} ${node.id}  (L${node.level} · ${node.kind})${cycle}`);
    for (const c of node.children) emit(c, depth + 1);
  }
  for (const r of roots) emit(r, 0);

  // Hyperedge view: equivalence classes of edges sharing a common member on
  // the same layer. Grouped by layer, then by the common member's fractal
  // level so the user can see which layer "lives" at which depth.
  const hyperByLayer = {};
  let totalHyperEdges = 0;
  if (hyperEdges) {
    for (const [, he] of hyperEdges) {
      totalHyperEdges++;
      const layer = he.layer || 'unknown';
      if (!hyperByLayer[layer]) hyperByLayer[layer] = [];
      hyperByLayer[layer].push({
        id: he.id,
        layer,
        commonMember: he.commonMember,
        memberLevel: levels.get(he.commonMember) ?? 0,
        edgeCount: he.edgeIds ? he.edgeIds.size : 0,
      });
    }
    for (const k of Object.keys(hyperByLayer)) {
      hyperByLayer[k].sort((a, b) => {
        if (a.memberLevel !== b.memberLevel) return a.memberLevel - b.memberLevel;
        return b.edgeCount - a.edgeCount;
      });
    }
    summary.totalHyperEdges = totalHyperEdges;
    summary.hyperEdgeLayers = Object.fromEntries(
      Object.entries(hyperByLayer).map(([k, v]) => [k, v.length]),
    );

    lines.push('');
    lines.push(`## Hyperedges`);
    lines.push(`- total: ${totalHyperEdges} across ${Object.keys(hyperByLayer).length} layer(s)`);
    lines.push('');
    const layerKeys = Object.keys(hyperByLayer).sort();
    for (const layer of layerKeys) {
      const list = hyperByLayer[layer];
      lines.push(`### layer: ${layer}  (${list.length} hyperedges)`);
      // Group within layer by member level for readability.
      const byLvl = new Map();
      for (const h of list) {
        if (!byLvl.has(h.memberLevel)) byLvl.set(h.memberLevel, []);
        byLvl.get(h.memberLevel).push(h);
      }
      const sortedLvls = Array.from(byLvl.keys()).sort((a, b) => a - b);
      for (const lvl of sortedLvls) {
        lines.push(`  L${lvl}:`);
        for (const h of byLvl.get(lvl)) {
          lines.push(`    · ${h.commonMember}  ×${h.edgeCount}`);
        }
      }
      lines.push('');
    }
  }

  return {
    tree: roots,
    byLevel,
    summary,
    hyperByLayer,
    markdown: lines.join('\n'),
    raw: {
      levels: Object.fromEntries(levels),
      clusterTargets: Array.from(clusterTargets),
      maxLevel,
    },
  };
}
