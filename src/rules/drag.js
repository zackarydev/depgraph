/**
 * Drag rule — snap members to an anchor + per-member offsets.
 *
 * Unified over node-drag, group-drag, and cluster-label drag: every flavor
 * is "members rigidly translate with a moving anchor point." The caller
 * mutates `moment.payload.anchorX/anchorY` as the pointer moves; each tick
 * computes a delta so `ps + delta == anchor + offset`.
 *
 * Payload:
 *   anchorX, anchorY: current world coords of the anchor (mouse cursor).
 *   offsets: Map<id, {dx,dy}> — each member's offset from the anchor.
 *     A primary-drag offset of {dx:0,dy:0} makes that member snap to the
 *     cursor; a cluster drag has offsets for every member.
 *
 * Locked members are skipped. Dispatcher sums deltas, so a drag composed
 * with a gather on overlapping ids produces the vector sum.
 *
 * @module rules/drag
 */

export const dragRule = {
  name: 'drag',

  tick(moment, ctx) {
    const { posMap } = ctx;
    if (!posMap) return null;
    const { anchorX, anchorY, offsets } = moment.payload;
    if (anchorX == null || anchorY == null || !offsets) return null;

    const posDeltas = new Map();
    for (const [id, off] of offsets) {
      const ps = posMap.positions.get(id);
      if (!ps || ps.locked) continue;
      const tx = anchorX + off.dx;
      const ty = anchorY + off.dy;
      posDeltas.set(id, { dx: tx - ps.x, dy: ty - ps.y });
    }
    return { posDeltas };
  },
};

/**
 * Build the offsets map for a node drag (primary + optional group members).
 * The primary always gets {0,0} so it snaps to the cursor; group members get
 * their current offset from the primary so the group translates rigidly.
 *
 * @param {string} primaryId
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {Iterable<string>} [groupMembers] - ids to drag along (excluding primary)
 * @returns {Map<string, {dx:number, dy:number}>}
 */
export function nodeDragOffsets(primaryId, posMap, groupMembers) {
  const offsets = new Map();
  const ps = posMap.positions.get(primaryId);
  if (!ps) return offsets;
  offsets.set(primaryId, { dx: 0, dy: 0 });
  if (groupMembers) {
    for (const id of groupMembers) {
      if (id === primaryId) continue;
      const other = posMap.positions.get(id);
      if (other && !other.locked) {
        offsets.set(id, { dx: other.x - ps.x, dy: other.y - ps.y });
      }
    }
  }
  return offsets;
}

/**
 * Build the offsets map for a cluster-label drag. All members' offsets are
 * measured from the starting anchor position (typically the mouse at
 * mousedown), so releasing at the same spot is a no-op.
 *
 * @param {Iterable<string>} memberIds
 * @param {number} anchorX0
 * @param {number} anchorY0
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {Map<string, {dx:number, dy:number}>}
 */
export function clusterDragOffsets(memberIds, anchorX0, anchorY0, posMap) {
  const offsets = new Map();
  for (const id of memberIds) {
    const ps = posMap.positions.get(id);
    if (ps && !ps.locked) {
      offsets.set(id, { dx: ps.x - anchorX0, dy: ps.y - anchorY0 });
    }
  }
  return offsets;
}
