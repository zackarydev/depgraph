# Rules reference

Every live interaction that moves positions is expressed as a **moment** on
the dispatcher. Each moment names the **rule** whose `tick(moment, ctx)` will
be called every frame while the moment is live. A rule returns a `posDeltas`
map (`id -> {dx, dy}`) that the dispatcher composes additively onto `posMap`,
so two moments targeting the same node produce the vector sum of their
contributions.

This document is the per-rule reference. The substrate itself (moments, HLC
coordinates, emit / retract / commit, `tick`) lives in
[src/core/dispatcher.js](../src/core/dispatcher.js) and is documented
in-module.

## Rule contract

```
rule = {
  name: string,
  tick(moment, ctx) -> { posDeltas?: Map<id, {dx,dy}> } | null
}
```

- `moment.payload` — free-form, set by the emitter at `emit()` time and
  (for continuous gestures like drag) mutated by the emitter between frames.
- `moment.members` — the set of ids the rule applies to (advisory; some rules
  ignore it and work off the payload instead).
- `moment.elapsed` — ms since the moment was emitted, updated by the rule.
- `ctx` — per-frame context the dispatcher builds:
  `{ posMap, edges, weights, arrangements, dt }`. A rule reads what it needs.

Rules must NOT mutate `posMap` directly — the dispatcher enforces composition
by applying `posDeltas` itself, skipping locked members. The one exception is
[relax](#relax), which snapshots, runs an imperative `descentStep`, and rolls
back before returning the diff.

---

## gather — [src/rules/gather.js](../src/rules/gather.js)

Pulls members toward a target point with a per-frame lerp. Used for the
Space-bar gather gesture (centroid, cluster, and stranger flavors).

**Payload**
- `targetX, targetY` — world coords to pull toward.
- `strength` — pull factor per second (default `3.0`). Each frame's step is
  `min(1, strength * dt / 1000)`.

**Context**
- `posMap`, `dt`.

**Behavior**
- Skips locked members.
- Members already within 0.5px of the target contribute zero (avoids jitter
  near convergence).
- Trajectory matches the legacy `updateGather()` — proven by parity tests.

**Helpers**
- `gatherCentroid(ids, posMap)` — mean of member positions.
- `neighborsOf(anchorId, edges, exclude?)` — used by the stranger-gather case
  (click + Space on an unselected node).

---

## drag — [src/rules/drag.js](../src/rules/drag.js)

Snaps members to `anchor + offset`. Unified over node drag, group drag, and
cluster-label drag — every flavor is "members rigidly translate with a moving
anchor point."

**Payload**
- `anchorX, anchorY` — current world coords of the anchor (the mouse cursor).
  Mutated by the emitter each `mousemove`.
- `offsets` — `Map<id, {dx, dy}>`. Each member's offset from the anchor; the
  rule computes a delta so `ps + delta == anchor + offset`.

**Context**
- `posMap`.

**Behavior**
- Skips locked members.
- The moment is emitted lazily on first `mousemove` past a 3px threshold so
  bare clicks never perturb positions.
- Dispatcher sums deltas, so a drag composed with a gather on overlapping ids
  produces the vector sum.

**Helpers**
- `nodeDragOffsets(primaryId, posMap, groupMembers?)` — primary gets
  `{0,0}` (snaps to cursor); group members get their current offset from the
  primary so the group translates rigidly.
- `clusterDragOffsets(memberIds, anchorX0, anchorY0, posMap)` — all offsets
  measured from the starting anchor, so releasing at the same spot is a no-op.

---

## relax — [src/rules/relax.js](../src/rules/relax.js)

One gradient-descent step per tick, expressed as position deltas. Collapses
the X-key reset and the cluster-expand descent-burst into a single rule.

**Payload**
- `eta` — step size (caller may scale by zoom for the descent-burst case).
- `scope` — `Set<id> | null`. If set, descent runs cluster-local: only edges
  with both endpoints in scope contribute, repulsion restricted to scope
  pairs, only scope members move.
- `collapse` — force collapse semantics (centroid pull, damped repulsion)
  even when the scope has no stretch signal.
- `clearSticky` — temporarily unstick every node for the duration of the
  step. X-key semantics: X is explicitly a relaxation gesture and should
  overpower drag stickiness. The flag is restored after the step.

**Context**
- `posMap`, `edges`, `weights`.

**Side-effect discipline**
`descentStep` mutates `posMap` imperatively. The rule snapshots, runs the
step, diffs to produce `posDeltas`, and rolls `posMap` back to pre-step
state. The dispatcher then re-applies the deltas (with its own locked-check)
alongside any other live moments' contributions, preserving additive
composition.

---

## arrangement-pull — [src/rules/arrangement-pull.js](../src/rules/arrangement-pull.js)

Walks the arrangement stack as time elapses, snapping `posMap` to each
snapshot via position deltas. Re-expresses the legacy `updateTravel()`
per-frame cursor walk.

**Payload**
- `direction` — `'back' | 'fwd'`.
- `stepMs` — ms between cursor advances (default `600`).

**Context**
- `posMap`, `arrangements`, `dt`.

**Behavior**
- Every `stepMs` of live time, the cursor advances one step in the requested
  direction and the rule emits `posDeltas` to align `posMap` with the new
  snapshot.
- At either end of the stack, returns `null` — further ticks are no-ops.

**Bookkeeping lives outside**
Start / stop bookkeeping (the `z-pending` and `z-travel` labels that
`arrangements.startTravel` / `stopTravel` manage) is a once-per-gesture
concern, not a per-frame one. The dispatcher doesn't need to own it; the
caller keeps calling `startTravel` / `stopTravel` around the moment.

---

## cluster-rules — [src/rules/cluster-rules.js](../src/rules/cluster-rules.js)

Not a dispatcher rule. This module is a set of **history-row builders** that
mutate the `stretch` scalar on a cluster's memberOf edges. The gradient
descent loop then animates the layout toward the new equilibrium — no
render-layer swap, no inward tween, the physics IS the animation.

**Stretch semantics** (see [src/layout/gradient.js](../src/layout/gradient.js)):
`target = BASE * exp(stretch)`.
- `stretch = 0` → default spring length.
- `stretch < 0` → contract (collapse members toward cluster node).
- `stretch > 0` → stretch (push members outward).

**Canonical values**
- `STRETCH_COLLAPSED = -2.0` (~14% of BASE).
- `STRETCH_DEFAULT = 0.0`.
- `STRETCH_EXPANDED = 1.5` (~448% of BASE).

**Exports**
- `clusterMembers(clusterId, graph)` — resolve a cluster id to its member
  set. Accepts both `cluster:X` and `cluster:cluster:X` forms.
- `setClusterStretchRule(clusterId, stretch, graph, meta?)` — produce
  `HistoryRow[]` setting stretch on every edge whose both endpoints are
  cluster members (plus the memberOf edges, for bookkeeping honesty).
- `collapseClusterRule`, `expandClusterRule`, `resetClusterStretchRule` —
  shortcuts that call `setClusterStretchRule` with canonical values.
- `readClusterStretch(clusterId, graph)` — average stretch of the cluster's
  structural edges. Tolerates drift.
- `toggleClusterStretchRule(clusterId, graph)` — cycle collapsed → default →
  expanded → collapsed. Returns `{ rows, next }`.

---

## click-events — [src/rules/click-events.js](../src/rules/click-events.js)

Not a dispatcher rule. This module records clicks as graph edges so
downstream consumers (gather, trace, reset) can query "what was last
clicked" without a separate JS object.

A sentinel node `mouse-clicked` lives in the graph. Each click appends an
`event:click` edge from the sentinel to the click target. The edge layer has
zero weight, so clicks accumulate in history without warping the graph.

**Exports**
- `SENTINEL_MOUSE_CLICKED` — id of the sentinel node (`'mouse-clicked'`).
- `CLICK_EDGE_LAYER` — `'event:click'`.
- `clickEdgeId(t, targetId)` — unique per `(t, target)` pair.
- `clickRow(targetId, meta?)` — history EDGE row for a click.
- `lastClickTarget(graph)` — id of the most recent click target, or `null`.
  Relies on `graph.state.edges` preserving insertion order.
- `sentinelRow()` — seed row for the sentinel node. Caller checks existence
  before appending.

---

## Stubs (not yet implemented)

These modules exist as placeholders for the phase-11 user-authored-rules
work. They export names so imports don't break, but the bodies are empty.

- [apply.js](../src/rules/apply.js) — `applyRule(rule, binding, history)`:
  rule application → transaction of history rows.
- [library.js](../src/rules/library.js) — `RULES`: built-in code rules
  (extract-fn, inline-fn, rename, merge/split cluster).
- [matcher.js](../src/rules/matcher.js) — `findMatches(graph, pattern)`:
  subgraph pattern matching (small graph isomorphism).
- [panel.js](../src/rules/panel.js) — `initPanel(container, rules, graph)`:
  suggestion side panel (v1: manual confirm only).
