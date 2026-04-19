/**
 * Relax rule — one gradient-descent step per tick, expressed as position deltas.
 *
 * Collapses the X-key reset and the cluster-expand descent-burst into a
 * single rule. Payload selects global vs cluster-scoped behavior.
 *
 * Payload:
 *   eta: step size (caller may scale by zoom for the descent-burst case).
 *   scope: Set<id> | null — if set, descent runs cluster-local (only edges
 *     with both endpoints in scope contribute, repulsion restricted to
 *     scope pairs, only scope members move).
 *   collapse: bool — force collapse semantics (centroid pull, damped
 *     repulsion) even when the scope has no stretch signal.
 *   clearSticky: bool — temporarily unstick every node for the duration of
 *     the step. This is the X-key semantics from the legacy updateReset():
 *     X is explicitly a relaxation gesture and should overpower drag stickiness.
 *
 * Side-effect discipline: descentStep mutates posMap imperatively, so the
 * rule takes a snapshot, runs the step, diffs to produce posDeltas, and
 * rolls posMap back to pre-step state. The dispatcher then re-applies the
 * deltas (with its own locked-check) alongside any other live moments'
 * contributions, preserving additive composition.
 *
 * @module rules/relax
 */

import { descentStep } from '../layout/gradient.js';

export const relaxRule = {
  name: 'relax',

  tick(moment, ctx) {
    const { posMap, edges, weights, nodes } = ctx;
    if (!posMap || !edges) return null;
    const { eta, scope, collapse, clearSticky, movable } = moment.payload;

    const before = new Map();
    for (const [id, ps] of posMap.positions) before.set(id, { x: ps.x, y: ps.y });

    let prevSticky = null;
    if (clearSticky) {
      prevSticky = new Map();
      for (const [id, ps] of posMap.positions) {
        if (ps.sticky) { prevSticky.set(id, true); ps.sticky = false; }
      }
    }

    descentStep(posMap, edges, weights, {
      eta,
      scope: scope || undefined,
      collapse: !!collapse,
      movable: movable || undefined,
      nodes,
    });

    if (prevSticky) {
      for (const [id, sticky] of prevSticky) {
        const ps = posMap.positions.get(id);
        if (ps) ps.sticky = sticky;
      }
    }

    const posDeltas = new Map();
    for (const [id, ps] of posMap.positions) {
      const b = before.get(id);
      if (!b) continue;
      const dx = ps.x - b.x;
      const dy = ps.y - b.y;
      ps.x = b.x;
      ps.y = b.y;
      if (dx !== 0 || dy !== 0) posDeltas.set(id, { dx, dy });
    }

    moment.elapsed += ctx.dt || 0;
    return { posDeltas };
  },
};
