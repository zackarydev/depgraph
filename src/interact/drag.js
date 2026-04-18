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

/**
 * End a drag. Makes the dragged node(s) sticky and returns history rows
 * to append (NODE update with new position in payload + spatial EDGE rows).
 *
 * @param {DragState} drag
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {Object} [opts]
 * @param {number} [opts.spatialK=5] - number of nearest neighbors for spatial edges
 * @returns {import('../core/types.js').HistoryRow[]} rows to append to history
 */
export function endDrag(drag, posMap, opts) {
  if (!drag.moved) return [];

  const rows = [];
  const spatialK = (opts && opts.spatialK) || 5;

  // Make dragged node sticky
  setSticky(posMap, drag.nodeId, true);
  const ps = posMap.positions.get(drag.nodeId);
  if (ps) {
    rows.push({
      type: 'NODE',
      op: 'update',
      id: drag.nodeId,
      _payload: { x: ps.x, y: ps.y, author: 'user', action: 'drag' },
    });

    // Emit spatial edges to K nearest neighbors
    const spatialRows = computeSpatialEdges(drag.nodeId, posMap, spatialK);
    rows.push(...spatialRows);
  }

  // Group drag: make all moved nodes sticky, record positions
  if (drag.isGroup) {
    for (const [id] of drag.offsets) {
      setSticky(posMap, id, true);
      const other = posMap.positions.get(id);
      if (other) {
        rows.push({
          type: 'NODE',
          op: 'update',
          id,
          _payload: { x: other.x, y: other.y, author: 'user', action: 'group-drag' },
        });
        const spatialRows = computeSpatialEdges(id, posMap, spatialK);
        rows.push(...spatialRows);
      }
    }
  }

  return rows;
}

/**
 * Compute spatial EDGE rows for a node's K nearest neighbors.
 * Distance becomes the edge weight (inverse: closer = higher weight).
 *
 * @param {string} nodeId
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {number} k
 * @returns {import('../core/types.js').HistoryRow[]}
 */
function computeSpatialEdges(nodeId, posMap, k) {
  const ps = posMap.positions.get(nodeId);
  if (!ps) return [];

  // Find distances to all other nodes
  const distances = [];
  for (const [otherId, otherPs] of posMap.positions) {
    if (otherId === nodeId) continue;
    const dx = ps.x - otherPs.x;
    const dy = ps.y - otherPs.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    distances.push({ id: otherId, dist });
  }

  // Sort by distance, take K nearest
  distances.sort((a, b) => a.dist - b.dist);
  const nearest = distances.slice(0, k);

  return nearest.map(({ id: otherId, dist }) => ({
    type: 'EDGE',
    op: 'add',
    id: `spatial:${nodeId}->${otherId}`,
    source: nodeId,
    target: otherId,
    layer: 'spatial',
    weight: Math.max(0.1, 1 / (1 + dist / 100)),
    _payload: { distance: Math.round(dist), author: 'user', action: 'drag-spatial' },
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
