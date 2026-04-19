/**
 * Hardcoded rewrite rules for cluster expand/collapse.
 *
 * These are engine-level rules (not user-authored phase-11 rules). Each rule
 * emits HistoryRow[] that modify the `stretch` scalar on the memberOf edges
 * targeting a given cluster node. The gradient-descent loop then animates the
 * layout toward the new equilibrium — no render-layer swap, no inward tween,
 * the physics IS the animation.
 *
 * Stretch semantics (see layout/gradient.js): target = BASE * exp(stretch).
 *   stretch = 0   → default spring length
 *   stretch < 0   → contract (collapse members toward cluster node)
 *   stretch > 0   → stretch (push members outward)
 *
 * @module rules/cluster-rules
 */

/** Canonical stretch values for the UI toggle. The engine accepts any real. */
export const STRETCH_COLLAPSED = -2.0; // ~14% of BASE
export const STRETCH_DEFAULT = 0.0;
export const STRETCH_EXPANDED = 1.5;   // ~448% of BASE

// Fallback state for clusters with no structural edges (e.g. affinity-only
// clusters where no edges have both endpoints inside the cluster).
const edgelessClusterStretch = new Map();

/**
 * Resolve the set of member node ids for a cluster. Derivation keys clusters
 * as `cluster:${edge.target}`, so `clusterId` is typically of the form
 * `cluster:cluster:render`. We accept either the prefixed or unprefixed form.
 *
 * @param {string} clusterId
 * @param {import('../data/graph-builder.js').Graph} graph
 * @returns {Set<string>}
 */
export function clusterMembers(clusterId, graph) {
  const members = new Set();
  // First try: derivation.clusters holds the same prefixed id used in the UI.
  const clusters = graph.derivation && graph.derivation.clusters;
  if (clusters) {
    const cl = clusters.get(clusterId);
    if (cl && cl.members) {
      for (const m of cl.members) members.add(m);
      if (members.size) return members;
    }
  }
  // Fallback: scan memberOf edges by target, stripping one `cluster:`.
  const candidates = new Set([clusterId]);
  if (clusterId.startsWith('cluster:cluster:')) {
    candidates.add(clusterId.slice('cluster:'.length));
  }
  for (const edge of graph.state.edges.values()) {
    if (edge.layer === 'memberOf' && candidates.has(edge.target)) {
      members.add(edge.source);
    }
  }
  return members;
}

/**
 * Find all edges the cluster-stretch rule should mutate. This is the union of:
 *   1) memberOf edges whose target is the cluster node (semantic marker — the
 *      cluster node itself has no position, so these contribute nothing to the
 *      physics, but recording the stretch keeps the history honest).
 *   2) All edges whose BOTH endpoints are members of the cluster — the real
 *      physics levers. Contracting these pulls members together; stretching
 *      them pushes members apart.
 *
 * @param {string} clusterId
 * @param {import('../data/graph-builder.js').Graph} graph
 * @returns {import('../core/types.js').Edge[]}
 */
function clusterStructuralEdges(clusterId, graph) {
  const members = clusterMembers(clusterId, graph);
  if (members.size === 0) return [];

  // Build the set of possible memberOf edge targets. The cluster id is
  // `cluster:X` where X is the memberOf target, so we always strip one
  // `cluster:` prefix. For double-prefixed ids (`cluster:cluster:X`) we
  // also try the single-stripped form.
  const clusterTargets = new Set([clusterId]);
  if (clusterId.startsWith('cluster:')) {
    clusterTargets.add(clusterId.slice('cluster:'.length));
  }

  const hits = [];
  for (const edge of graph.state.edges.values()) {
    if (edge.layer === 'memberOf' && clusterTargets.has(edge.target)) {
      hits.push(edge);
      continue;
    }
    if (members.has(edge.source) && members.has(edge.target)) {
      hits.push(edge);
    }
  }
  return hits;
}

/**
 * Emit history rows that set the stretch of every memberOf edge into
 * `clusterId` to `stretch`. Caller is responsible for appending these
 * through the normal history pipeline (so rederive + descent fire).
 *
 * @param {string} clusterId
 * @param {number} stretch
 * @param {import('../data/graph-builder.js').Graph} graph
 * @param {Object} [meta] - optional metadata recorded on each row's payload
 * @returns {import('../core/types.js').HistoryRow[]}
 */
export function setClusterStretchRule(clusterId, stretch, graph, meta) {
  const edges = clusterStructuralEdges(clusterId, graph);
  const action = meta && meta.action;
  const rows = [];
  for (const e of edges) {
    // Single EDGE update with `stretch` in the payload. expandPayload sees
    // `stretch` as a slot key and emits the slot node + stretch-layer edge;
    // applyRow's stretch mirror caches the scalar back onto this edge.
    rows.push({
      type: 'EDGE',
      op: 'update',
      id: e.id,
      _payload: {
        author: 'user',
        action: action || 'cluster-stretch',
        cluster: clusterId,
        stretch,
      },
    });
  }
  return rows;
}

/** Collapse shortcut: stretch = STRETCH_COLLAPSED. */
export function collapseClusterRule(clusterId, graph) {
  return setClusterStretchRule(clusterId, STRETCH_COLLAPSED, graph, { action: 'cluster-collapse' });
}

/** Expand shortcut: stretch = STRETCH_EXPANDED. */
export function expandClusterRule(clusterId, graph) {
  return setClusterStretchRule(clusterId, STRETCH_EXPANDED, graph, { action: 'cluster-expand' });
}

/** Reset shortcut: stretch = 0 (identity). */
export function resetClusterStretchRule(clusterId, graph) {
  return setClusterStretchRule(clusterId, STRETCH_DEFAULT, graph, { action: 'cluster-reset' });
}

/**
 * Inspect the current stretch of a cluster's memberOf edges. Returns the
 * average — in practice all edges are in sync because the rules set them
 * atomically, but averaging tolerates drift.
 *
 * @param {string} clusterId
 * @param {import('../data/graph-builder.js').Graph} graph
 * @returns {number}
 */
export function readClusterStretch(clusterId, graph) {
  const edges = clusterStructuralEdges(clusterId, graph);
  if (edges.length === 0) return edgelessClusterStretch.get(clusterId) || 0;
  let sum = 0;
  for (const e of edges) sum += e.stretch || 0;
  return sum / edges.length;
}

/**
 * Cycle a cluster through collapsed → default → expanded → collapsed.
 * Returns the rows needed to advance one step.
 *
 * @param {string} clusterId
 * @param {import('../data/graph-builder.js').Graph} graph
 * @returns {{ rows: import('../core/types.js').HistoryRow[], next: number }}
 */
export function toggleClusterStretchRule(clusterId, graph) {
  const cur = readClusterStretch(clusterId, graph);
  let next;
  if (cur > 0.5) next = STRETCH_COLLAPSED;
  else if (cur < -0.5) next = STRETCH_DEFAULT;
  else next = STRETCH_EXPANDED;
  const rows = setClusterStretchRule(clusterId, next, graph, { action: 'cluster-toggle' });
  // Track state for edgeless clusters so the toggle cycle works.
  if (rows.length === 0) edgelessClusterStretch.set(clusterId, next);
  return { rows, next };
}
