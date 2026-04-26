/**
 * Drag-event stream: package each completed drag with enough context for an
 * external interpreter (an LLM, by default) to decide whether the gesture
 * implies any code change.
 *
 * Deliberately *not* an "intent extractor" — there is no taxonomy of
 * SplitIntent / MergeIntent / DeleteIntent. The local code's job is to
 * package, not classify. Whether a particular drag means "split this
 * function" or "the user is making space" or "accidental click" is the
 * model's job to decide. See RUNTIME_RULES.md (The editing feedback loop).
 *
 * The package contains:
 *   - the dragged node(s) with prev/new position and delta
 *   - graph 1-hop neighbors (any edge incident to the primary)
 *   - spatial-proximity neighbors (any node within R, regardless of edges)
 *   - both world distance and screen distance for each nearby node
 *
 * Spatial proximity matters even when graph distance is large. Large
 * codebases organize unrelated functions next to each other on screen
 * because the user grouped them visually; that grouping is signal even
 * though no edge connects them.
 *
 * @module agent/drag-events
 */

/**
 * @typedef {Object} DragEvent
 * @property {number} t - wall-clock ms when the drag ended
 * @property {'node'|'cluster'} flavor
 * @property {{id:string, kind:string, label:string, prev:{x,y}|null, pos:{x,y}, delta:{dx,dy,dist}|null}} primary
 * @property {Array<{id:string, kind:string, label:string, prev, pos}>} members - other dragged ids (group drag)
 * @property {Array<NearbyNode>} nearby - merged graph + spatial neighbors, sorted by screen distance
 * @property {number} zoom - current zoom factor (screen px per world unit)
 */

/**
 * @typedef {Object} NearbyNode
 * @property {string} id
 * @property {string} kind
 * @property {string} label
 * @property {{x:number,y:number}} pos
 * @property {number} distWorld
 * @property {number} distScreen
 * @property {{layer:string, weight:number, direction:'in'|'out'}|null} edge - non-null if a graph edge connects this node to the dragged primary
 */

/**
 * @param {Object} args
 * @param {import('../core/bus.js').Bus} args.bus
 * @param {import('../core/state.js').State} args.state
 * @param {import('../layout/positions.js').PositionMap} args.posMap
 * @param {() => number} [args.getZoom] - returns the current zoom factor
 * @param {{ radiusWorld?: number, radiusScreen?: number }} [args.opts]
 * @returns {{ onEvent: (cb: (e: DragEvent) => void) => () => void, close: () => void }}
 */
export function createDragEventStream({ bus, state, posMap, getZoom = () => 1, opts = {} }) {
  const radiusWorld = opts.radiusWorld != null ? opts.radiusWorld : 250;
  const radiusScreen = opts.radiusScreen != null ? opts.radiusScreen : 220;
  const callbacks = new Set();

  /** @type {{primaryId:string, memberIds:string[], flavor:'node'|'cluster', prevPositions:Map<string,{x,y}>}|null} */
  let pending = null;

  function onStarted(evt) {
    pending = {
      primaryId: evt.primaryId,
      memberIds: evt.memberIds,
      flavor: evt.flavor,
      prevPositions: evt.positions,
    };
  }

  function onEnded() {
    if (!pending) return;
    const event = packageDragEvent(pending, state, posMap, getZoom(), { radiusWorld, radiusScreen });
    pending = null;
    if (event) for (const cb of callbacks) cb(event);
  }

  bus.on('drag-started', onStarted);
  bus.on('drag-ended', onEnded);

  return {
    onEvent(cb) {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    close() {
      callbacks.clear();
      pending = null;
    },
  };
}

function packageDragEvent(pending, state, posMap, zoom, opts) {
  const primaryNode = state.nodes.get(pending.primaryId);
  const primaryNew = posMap.positions.get(pending.primaryId);
  if (!primaryNode || !primaryNew) return null;

  const primaryPrev = pending.prevPositions.get(pending.primaryId) || null;
  const primary = {
    id: pending.primaryId,
    kind: primaryNode.kind,
    label: primaryNode.label,
    prev: primaryPrev ? { x: round(primaryPrev.x), y: round(primaryPrev.y) } : null,
    pos: { x: round(primaryNew.x), y: round(primaryNew.y) },
    delta: primaryPrev
      ? {
          dx: round(primaryNew.x - primaryPrev.x),
          dy: round(primaryNew.y - primaryPrev.y),
          dist: round(Math.hypot(primaryNew.x - primaryPrev.x, primaryNew.y - primaryPrev.y)),
        }
      : null,
  };

  const members = [];
  for (const id of pending.memberIds) {
    if (id === pending.primaryId) continue;
    const node = state.nodes.get(id);
    const newPos = posMap.positions.get(id);
    const prevPos = pending.prevPositions.get(id);
    if (!node || !newPos) continue;
    members.push({
      id,
      kind: node.kind,
      label: node.label,
      prev: prevPos ? { x: round(prevPos.x), y: round(prevPos.y) } : null,
      pos: { x: round(newPos.x), y: round(newPos.y) },
    });
  }

  // 1-hop graph neighbors of the primary. Direction tracks whether the
  // edge points outward (primary → other) or inward (other → primary).
  const graphEdges = new Map();
  for (const [, edge] of state.edges) {
    let other = null;
    let direction = null;
    if (edge.source === pending.primaryId) { other = edge.target; direction = 'out'; }
    else if (edge.target === pending.primaryId) { other = edge.source; direction = 'in'; }
    else continue;
    if (!graphEdges.has(other)) {
      graphEdges.set(other, { layer: edge.layer, weight: edge.weight, direction });
    }
  }

  // Spatial-proximity neighbors. Computed against the primary's NEW position
  // (the place the user just moved it to) so "what is now near it" is the
  // signal, not "what was near where it came from".
  const memberSet = new Set(pending.memberIds);
  const nearbyIds = new Set(graphEdges.keys());
  for (const [id, ps] of posMap.positions) {
    if (memberSet.has(id)) continue;
    const dx = ps.x - primaryNew.x;
    const dy = ps.y - primaryNew.y;
    const distWorld = Math.hypot(dx, dy);
    const distScreen = distWorld * zoom;
    if (distWorld <= opts.radiusWorld || distScreen <= opts.radiusScreen) {
      nearbyIds.add(id);
    }
  }

  const nearby = [];
  for (const id of nearbyIds) {
    const node = state.nodes.get(id);
    const ps = posMap.positions.get(id);
    if (!node || !ps) continue;
    const dx = ps.x - primaryNew.x;
    const dy = ps.y - primaryNew.y;
    const distWorld = Math.hypot(dx, dy);
    nearby.push({
      id,
      kind: node.kind,
      label: node.label,
      pos: { x: round(ps.x), y: round(ps.y) },
      distWorld: Math.round(distWorld),
      distScreen: Math.round(distWorld * zoom),
      edge: graphEdges.get(id) || null,
    });
  }
  nearby.sort((a, b) => a.distScreen - b.distScreen);

  return {
    t: Date.now(),
    flavor: pending.flavor,
    primary,
    members,
    nearby,
    zoom: round(zoom, 3),
  };
}

function round(n, digits = 1) {
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}
