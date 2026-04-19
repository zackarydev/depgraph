/**
 * Node drag, group drag, cluster-label drag -> history append.
 *
 * Pure logic: computes position deltas and writes history rows.
 * Does not touch the DOM. The animation scheduler picks up new
 * positions from the PositionMap each frame.
 *
 * SPEC §10: drag = mousedown+move, cleanup = mouseup (writes history row).
 * Shift+drag with selection = group move. Dragged nodes become sticky.
 *
 * @module interact/drag
 */

import { updatePosition, setSticky } from '../layout/positions.js';
import { rebuild as rebuildQuadtree, nearest as quadtreeNearest } from '../layout/quadtree.js';

/**
 * @typedef {Object} DragState
 * @property {string} nodeId - the node being dragged
 * @property {boolean} isGroup - whether dragging the whole selection
 * @property {number} startX - world x at drag start
 * @property {number} startY - world y at drag start
 * @property {Map<string, {dx: number, dy: number}>} offsets - for group drag: offset from primary
 * @property {boolean} moved - whether any actual movement happened
 */

/**
 * Begin a drag operation.
 *
 * @param {string} nodeId - the node being dragged
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {import('./select.js').SelectionState} selection
 * @param {boolean} isShift - shift held = group drag
 * @returns {DragState|null} null if node has no position
 */
export function startDrag(nodeId, posMap, selection, isShift) {
  const ps = posMap.positions.get(nodeId);
  if (!ps) return null;

  const isGroup = isShift && selection.selected.size > 1 && selection.selected.has(nodeId);
  const offsets = new Map();

  if (isGroup) {
    for (const id of selection.selected) {
      if (id === nodeId) continue;
      const other = posMap.positions.get(id);
      if (other && !other.locked) {
        offsets.set(id, { dx: other.x - ps.x, dy: other.y - ps.y });
      }
    }
  }

  return {
    nodeId,
    isGroup,
    startX: ps.x,
    startY: ps.y,
    offsets,
    moved: false,
  };
}

/**
 * Update positions during a drag.
 *
 * @param {DragState} drag
 * @param {number} worldX - new world x for the dragged node
 * @param {number} worldY - new world y for the dragged node
 * @param {import('../layout/positions.js').PositionMap} posMap
 */
export function onDrag(drag, worldX, worldY, posMap) {
  const ps = posMap.positions.get(drag.nodeId);
  if (!ps || ps.locked) return;

  updatePosition(posMap, drag.nodeId, worldX, worldY);
  drag.moved = true;

  if (drag.isGroup) {
    for (const [id, offset] of drag.offsets) {
      updatePosition(posMap, id, worldX + offset.dx, worldY + offset.dy);
    }
  }
}

// Emit an x/y position for `ownerId` as a slot node + edge pair. The edge's
// `source=owner, target=slot` shape means replay can discover positions by
// scanning edges (layer=x/y) — no string-parsing of slot ids required.
function positionRows(hlc, ownerId, x, y) {
  const rows = [];
  for (const [key, value] of [['x', x], ['y', y]]) {
    const id = `${hlc.next()}:${key}:${ownerId}`;
    rows.push({ type: 'NODE', op: 'add', id, kind: 'slot', weight: value, label: String(value) });
    rows.push({ type: 'EDGE', op: 'add', id, source: ownerId, target: id, layer: key, weight: 1 });
  }
  return rows;
}

/**
 * End a drag. Makes the dragged node(s) sticky and returns history rows
 * to append (NODE update + x/y slot nodes/edges + spatial EDGE rows).
 *
 * Neighbor search runs over the `spatial` property listener's node set —
 * the subset of nodes known to have x/y slot edges, not every entry in
 * posMap (which includes slot and sentinel nodes). A quadtree over that
 * set is built once per drag and reused across dragged nodes.
 *
 * @param {DragState} drag
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {Object} [opts]
 * @param {number} [opts.spatialK=5] - number of nearest neighbors for spatial edges
 * @param {{next: function(): string}} [opts.hlc] - HLC for slot id minting
 * @param {import('../core/properties.js').PropertyListener} [opts.spatial] - spatial listener (required for spatial edges)
 * @returns {import('../core/types.js').HistoryRow[]} rows to append to history
 */
export function endDrag(drag, posMap, opts) {
  if (!drag.moved) return [];

  const rows = [];
  const spatialK = (opts && opts.spatialK) || 5;
  const hlc = opts && opts.hlc;
  const spatial = opts && opts.spatial;

  const tree = spatial ? buildSpatialTree(spatial, posMap) : null;

  setSticky(posMap, drag.nodeId, true);
  const ps = posMap.positions.get(drag.nodeId);
  if (ps) {
    rows.push({ type: 'NODE', op: 'update', id: drag.nodeId });
    if (hlc) rows.push(...positionRows(hlc, drag.nodeId, ps.x, ps.y));
    if (tree) rows.push(...computeSpatialEdges(drag.nodeId, posMap, tree, spatialK));
  }

  if (drag.isGroup) {
    for (const [id] of drag.offsets) {
      setSticky(posMap, id, true);
      const other = posMap.positions.get(id);
      if (other) {
        rows.push({ type: 'NODE', op: 'update', id });
        if (hlc) rows.push(...positionRows(hlc, id, other.x, other.y));
        if (tree) rows.push(...computeSpatialEdges(id, posMap, tree, spatialK));
      }
    }
  }

  return rows;
}

/**
 * Build a quadtree over the spatial listener's node set, using current
 * positions from posMap. Nodes in the listener without a live position
 * are skipped (should be rare — listener admits on x/y slot edges, which
 * are emitted alongside position updates).
 *
 * @param {import('../core/properties.js').PropertyListener} spatial
 * @param {import('../layout/positions.js').PositionMap} posMap
 */
function buildSpatialTree(spatial, posMap) {
  const pts = [];
  for (const id of spatial.nodes.keys()) {
    const ps = posMap.positions.get(id);
    if (ps) pts.push({ id, x: ps.x, y: ps.y });
  }
  return rebuildQuadtree(pts);
}

/**
 * Compute spatial EDGE rows for a node's K nearest neighbors.
 * Distance becomes the edge weight (inverse: closer = higher weight).
 * Excludes the node itself from candidates.
 *
 * @param {string} nodeId
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {import('../layout/quadtree.js').QTNode} tree - prebuilt over spatial set
 * @param {number} k
 * @returns {import('../core/types.js').HistoryRow[]}
 */
function computeSpatialEdges(nodeId, posMap, tree, k) {
  const ps = posMap.positions.get(nodeId);
  if (!ps) return [];

  const neighbors = quadtreeNearest(tree, ps, k, (p) => p.id !== nodeId);

  return neighbors.map(({ id: otherId, dist }) => ({
    type: 'EDGE',
    op: 'add',
    id: `spatial:${nodeId}->${otherId}`,
    source: nodeId,
    target: otherId,
    layer: 'spatial',
    weight: Math.max(0.1, 1 / (1 + dist / 100)),
  }));
}

/**
 * Compute the set of node ids affected by a drag (primary + group members).
 * @param {DragState} drag
 * @returns {Set<string>}
 */
export function draggedNodes(drag) {
  const ids = new Set([drag.nodeId]);
  for (const id of drag.offsets.keys()) ids.add(id);
  return ids;
}
