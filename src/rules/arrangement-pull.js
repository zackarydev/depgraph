/**
 * Arrangement-pull rule — walk the arrangement stack as time elapses,
 * snapping posMap to each snapshot via position deltas.
 *
 * The arrangement stack is a stack of layout snapshots — drag-end,
 * reset-release, gather-stop all push one. This rule re-expresses the
 * legacy `updateTravel()` per-frame cursor walk: every `stepMs` of live
 * time, the cursor advances one step in the requested direction and the
 * rule emits posDeltas to align posMap with the new snapshot.
 *
 * Start/stop bookkeeping (the 'z-pending' and 'z-travel' labels that
 * arrangements.startTravel/stopTravel manage) stay outside the rule: the
 * dispatcher doesn't need to own them and they're a once-per-gesture
 * concern rather than a per-frame one.
 *
 * Payload:
 *   direction: 'back' | 'fwd'
 *   stepMs: ms between cursor advances (default 600).
 *
 * Context:
 *   arrangements: the ArrangementStack to walk.
 *   posMap: target layout.
 *
 * @module rules/arrangement-pull
 */

export const arrangementPullRule = {
  name: 'arrangement-pull',

  tick(moment, ctx) {
    const { posMap, arrangements, dt } = ctx;
    if (!posMap || !arrangements || !dt) return null;
    const { direction } = moment.payload;
    const stepMs = moment.payload.stepMs || 600;

    moment.elapsed += dt;
    if (moment.elapsed < stepMs) return null;
    moment.elapsed = 0;

    const st = arrangements;
    if (direction === 'back' && st.cursor > 0) st.cursor -= 1;
    else if (direction === 'fwd' && st.cursor < st.stack.length - 1) st.cursor += 1;
    else return null;

    const arr = st.stack[st.cursor];
    if (!arr) return null;

    const posDeltas = new Map();
    for (const [id, p] of arr.positions) {
      const ps = posMap.positions.get(id);
      if (!ps) continue;
      posDeltas.set(id, { dx: p.x - ps.x, dy: p.y - ps.y });
    }
    return { posDeltas };
  },
};
