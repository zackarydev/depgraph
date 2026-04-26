/**
 * Fractal level-of-detail: hide/show nodes by zoom-vs-cluster-depth.
 *
 * A node X has fractalLevel = how many cluster expansions are needed to
 * reach X starting from a top-level cluster. Top-level cluster targets are
 * level 0, their members are level 1, members of those (when themselves
 * cluster targets) are level 2, etc.
 *
 * At a given zoom k, currentMaxLevel(k) decides the deepest level visible.
 * Visibility rule:
 *   - if X.level < currentMaxLevel and X is a cluster target, HIDE X
 *     (its cluster has been "expanded" — its members are taking its place)
 *   - if X.level > currentMaxLevel, HIDE X
 *     (its parent cluster hasn't been expanded yet)
 *   - otherwise, SHOW X
 *
 * Edges are visible iff both endpoints are visible. Hulls are visible only
 * for clusters that are currently expanded.
 *
 * @module render/fractal-lod
 */

/**
 * Zoom thresholds in scale units. Index = level. A node at level L is
 * visible when k >= LEVEL_THRESHOLDS[L] AND k < LEVEL_THRESHOLDS[L+1]
 * (when X is a cluster target, otherwise just the lower bound).
 *
 * Default d3 zoom boots at k=1, so threshold[1] > 1 keeps the user at
 * level 0 on first paint — they see the collapsed root and reveal levels
 * by scrolling in.
 */
export const LEVEL_THRESHOLDS = [0, 1.5, 3.0, 6.0];

/**
 * Deepest level visible at zoom k.
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
 * cluster is level 2, and so on. Nodes outside the cluster hierarchy
 * (orphans) are placed at level 0 so they always render.
 *
 * @param {Map<string, import('../core/types.js').Cluster>} clusters
 * @param {Map<string, import('../core/types.js').Node>} nodes
 * @returns {{ levels: Map<string, number>, clusterTargets: Set<string>, maxLevel: number }}
 */
export function computeFractalLevels(clusters, nodes) {
  // memberToCluster: nodeId -> id of the cluster that owns it
  const memberToCluster = new Map();
  for (const [cid, c] of clusters) {
    for (const m of c.members) memberToCluster.set(m, cid);
  }

  // clusterTargets: the set of node ids that have a cluster derived from them
  // (so cluster:<id> exists and the node is a "cluster representative").
  const clusterTargets = new Set();
  for (const cid of clusters.keys()) {
    clusterTargets.add(cid.replace(/^(cluster:)+/, ''));
  }

  // Walk parent-cluster chain from each node up to the root. A VISITING
  // sentinel breaks cycles (a node clustered into its own ancestor — can
  // happen when affinity-based clustering ties two nodes to each other).
  const levels = new Map();
  const VISITING = -1;
  let maxLevel = 0;
  function levelOf(id) {
    const cached = levels.get(id);
    if (cached === VISITING) return 0; // cycle — treat as root
    if (cached != null) return cached;
    const parentClusterId = memberToCluster.get(id);
    if (!parentClusterId) {
      // Not a member of any cluster. If it's a cluster target itself, it's
      // a root (level 0). Otherwise it's an orphan — also level 0.
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
 * Toggle DOM visibility on the v3 renderer state to reflect the current
 * fractal LOD. Cheap — just sets `display` on existing elements; no DOM
 * tear-down/rebuild and no physics interruption.
 *
 * @param {Object} state - v3 renderer state
 * @param {Object} deps - { graph }
 * @param {number} k - current zoom scale
 */
export function applyFractalLod(state, deps, k) {
  const fl = state.fractalLod;
  if (!fl) return;

  const maxLvl = currentMaxLevel(k);
  const levelChanged = state._lastFractalMaxLevel !== maxLvl;
  state._lastFractalMaxLevel = maxLvl;

  const { levels, clusterTargets } = fl;

  // Per-node visibility predicate.
  function visible(id) {
    const lvl = levels.get(id);
    if (lvl == null) return true; // unknown node — render it
    if (lvl > maxLvl) return false;
    if (lvl < maxLvl && clusterTargets.has(id)) return false; // expanded away
    return true;
  }

  if (levelChanged) {
    // Nodes
    for (const [id, g] of state.nodeElements) {
      g.style.display = visible(id) ? '' : 'none';
    }

    // Labels
    for (const [id, t] of state.labelElements) {
      t.style.display = visible(id) ? '' : 'none';
    }

    // Edges — edgeElements is keyed `e:<edgeId>` (regular) or
    // `m:<clusterA>\0<clusterB>` (meta). Strip the prefix to look the edge
    // up; `graph.state.edges.get(key)` directly was the original bug —
    // every key missed and we fell into the "leave displayed" branch.
    if (deps && deps.graph) {
      for (const [key, line] of state.edgeElements) {
        let v = true;
        if (key.startsWith('e:')) {
          const edge = deps.graph.state.edges.get(key.slice(2));
          if (edge) v = visible(edge.source) && visible(edge.target);
        } else if (key.startsWith('m:')) {
          // Meta edges connect cluster centroids. Only meaningful when
          // both endpoint-clusters are currently representing a level.
          const sep = key.indexOf('\0');
          if (sep > 0) {
            const a = key.slice(2, sep).replace(/^(cluster:)+/, '');
            const b = key.slice(sep + 1).replace(/^(cluster:)+/, '');
            v = levels.get(a) === maxLvl && levels.get(b) === maxLvl;
          }
        }
        line.style.display = v ? '' : 'none';
        const arrow = state.arrowElements && state.arrowElements.get(key);
        if (arrow) arrow.style.display = v ? '' : 'none';
      }
    }

    // Hulls — show only for clusters whose members are currently visible
    // (i.e. clusters at level < maxLvl).
    for (const [cid, he] of state.hullElements) {
      const target = cid.replace(/^(cluster:)+/, '');
      const targetLvl = levels.get(target);
      const expanded = targetLvl != null && targetLvl < maxLvl;
      he.path.style.display = expanded ? '' : 'none';
    }

    for (const [cid, t] of state.clusterLabelElements) {
      const target = cid.replace(/^(cluster:)+/, '');
      const targetLvl = levels.get(target);
      const expanded = targetLvl != null && targetLvl < maxLvl;
      t.style.display = expanded ? '' : 'none';
    }
  }

  // Always-on: force labels of currently-visible nodes to full opacity.
  // applySemanticZoom otherwise fades labels by screen-radius (screenR < 6
  // → opacity 0), which makes a single zoomed-out cluster representative
  // unreadable. If a node is the only stand-in for an entire cluster, its
  // label has to be legible regardless of camera scale.
  for (const [id, t] of state.labelElements) {
    if (visible(id)) t.setAttribute('opacity', '1');
  }
}
