/**
 * Click events as graph edges.
 *
 * A sentinel node `mouse-clicked` lives in the graph. Each click on a node
 * or cluster label appends an `event:click` edge from the sentinel to the
 * click target. History.csv records every click; consumers query the graph
 * for the most recent edge to learn "what was last clicked."
 *
 * This is the first move of a larger shift: selection and other UI state
 * become edges in the graph, not a separate JS object. Downstream consumers
 * (gather, trace, reset) can migrate one at a time.
 *
 * @module rules/click-events
 */

export const SENTINEL_MOUSE_CLICKED = 'mouse-clicked';
export const CLICK_EDGE_LAYER = 'event:click';

/**
 * Build an edge id unique to this click. Embeds the history timestamp so the
 * edges are ordered and distinct across rapid-fire clicks.
 * @param {number} t - history row timestamp
 * @param {string} targetId
 * @returns {string}
 */
export function clickEdgeId(t, targetId) {
  return `click:${t}:${targetId}`;
}

/**
 * Build a history EDGE row representing a click. Caller appends it through
 * the normal pipeline so localStorage + SSE + rebuild all see it.
 *
 * @param {string} targetId - node the user clicked
 * @param {Object} [meta] - extra payload fields (e.g. shiftKey)
 * @returns {import('../core/types.js').HistoryRow}
 */
export function clickRow(targetId, meta) {
  return {
    type: 'EDGE',
    op: 'add',
    // id is filled in by the caller using clickEdgeId(t, targetId) once the
    // history timestamp is known. History.append assigns t, so we leave a
    // placeholder and let the caller rewrite — but to keep this helper pure,
    // we pass targetId twice and let appendRow's id fall through.
    source: SENTINEL_MOUSE_CLICKED,
    target: targetId,
    layer: CLICK_EDGE_LAYER,
    weight: 0,
    payload: {
      author: 'user',
      action: 'click',
      target: targetId,
      ...(meta || {}),
    },
  };
}

/**
 * Find the target of the most recent `event:click` edge from the sentinel.
 * Relies on graph.state.edges preserving insertion order (Map semantics).
 *
 * @param {import('../data/graph-builder.js').Graph} graph
 * @returns {string|null} targetId of the last click, or null if none yet
 */
export function lastClickTarget(graph) {
  if (!graph || !graph.state || !graph.state.edges) return null;
  let latest = null;
  for (const edge of graph.state.edges.values()) {
    if (edge.layer === CLICK_EDGE_LAYER && edge.source === SENTINEL_MOUSE_CLICKED) {
      latest = edge.target;
    }
  }
  return latest;
}

/**
 * Row to seed the sentinel node if it doesn't exist yet. Idempotent at the
 * caller level: caller checks `graph.state.nodes.has(SENTINEL_MOUSE_CLICKED)`
 * before appending.
 *
 * @returns {import('../core/types.js').HistoryRow}
 */
export function sentinelRow() {
  return {
    type: 'NODE',
    op: 'add',
    id: SENTINEL_MOUSE_CLICKED,
    kind: 'sentinel',
    label: SENTINEL_MOUSE_CLICKED,
    weight: 0.1,
    payload: { author: 'system', action: 'sentinel-init' },
  };
}
