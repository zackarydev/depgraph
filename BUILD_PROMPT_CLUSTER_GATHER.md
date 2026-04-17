# Plan: Cluster-Label Selection & Cluster Gather

## The bug

When the user clicks or holds a cluster's label and then presses Space, nothing
happens. The dispatcher's `gather-start` handler currently has two cases:

```js
// src/main.js ~ gather-start
if (selection.selected.size >= 2) { ... }            // centroid gather
else if (selection.primary) { ... }                  // stranger gather
```

A cluster-label click satisfies neither. Looking at
[src/main.js:405-437](src/main.js#L405-L437), the mousedown handler for a cluster
label sets up `clusterDragState` for potential dragging but **never touches
`selection`**. So:

- `selection.selected.size` stays at 0.
- `selection.primary` stays `null`.
- Space-bar sees nothing to gather and silently no-ops.

The user's note: *"Perhaps we should have that [the cluster] as the first object
state."* — the cluster node IS a node in the graph (there are `NODE kind=cluster`
rows emitted by the codemap producer), so the cleanest fix is to treat it as a
first-class selection target, not a parallel state.

## The fix — three layers

### 1. Cluster-label mousedown populates selection

On cluster-label mousedown, promote the cluster node to `selection.primary` (and
optionally the sole member of `selection.selected`). Exactly what we do today for
a plain node click via `startDrag` — but with the cluster id.

**Location:** [src/main.js:414-437](src/main.js#L414-L437) — inside the
`if (clusterId) { ... }` block, alongside `clusterDragState = {...}`.

```js
// Promote the cluster to primary selection so keyboard modes
// (gather, trace, reset) can target it.
selection = e.shiftKey
  ? toggleSelection(selection, clusterId)
  : selectNode(selection, clusterId);
bus.emit('selection-changed', { selected: selection.selected, primary: selection.primary });
```

Import `selectNode, toggleSelection` from `./interact/select.js` if not already
imported at that scope.

### 2. Dispatcher `gather-start` grows a cluster case

A cluster as `selection.primary` should pull its **members** toward the
cluster's centroid — not its "neighbors" (which is what stranger-gather does).
This is the same semantics as the existing `startClusterGather()` in
[src/interact/gather.js:143](src/interact/gather.js#L143), but re-expressed as
a moment emit.

**Location:** [src/main.js:548-575](src/main.js#L548-L575) — the `gather-start`
case of the keydown switch.

Order the checks so the cluster path is tried first (primary being a cluster
is more specific than "primary exists"):

```js
case 'gather-start': {
  let members = null;
  let target = null;

  // Cluster gather: if primary is a cluster node, pull members toward centroid.
  const prim = selection.primary && graph.state.nodes.get(selection.primary);
  if (prim && prim.kind === 'cluster') {
    const clusterMembers = legacyState && legacyState.clusterMembers.get(selection.primary);
    if (clusterMembers && clusterMembers.size >= 2) {
      members = [...clusterMembers];
      target = gatherCentroid(members, posMap);
    }
  }

  // Multi-select centroid gather.
  if (!members && selection.selected.size >= 2) {
    members = [...selection.selected];
    target = gatherCentroid(members, posMap);
  }

  // Stranger gather: single node primary, pull its neighbors toward it.
  if (!members && selection.primary) {
    members = neighborsOf(selection.primary, graph.state.edges, selection.selected);
    const ps = posMap.positions.get(selection.primary);
    if (ps) target = { x: ps.x, y: ps.y };
  }

  if (members && members.length > 0 && target) {
    activeGatherMoment = emitMoment(dispatcher, {
      rule: 'gather',
      members,
      payload: { targetX: target.x, targetY: target.y, strength: 3.0 },
      author: 'user',
    });
    scheduler.register('gather', (dt) => {
      tickDispatcher(dispatcher, dt, { posMap, edges: graph.state.edges });
    });
  }
  break;
}
```

### 3. Cluster members — resolve from graph, not from legacyState

`legacyState.clusterMembers` is a render-side cache that may not exist in
headless/test contexts. Prefer the graph-level resolver that already exists:
[src/rules/cluster-rules.js](src/rules/cluster-rules.js) exports
`clusterMembers(clusterId, graph)`. Use it as the source of truth. 

Unsure whether to use the fall back to
`legacyState.clusterMembers` only if the graph has no `memberOf` edges to the cluster (shouldn't happen in practice, but safe).

```js
import { clusterMembers as resolveClusterMembers } from './rules/cluster-rules.js';
// ...
const clusterMembers = resolveClusterMembers(selection.primary, graph) ||
                       (legacyState && legacyState.clusterMembers.get(selection.primary));
```

`resolveClusterMembers` is already imported at [src/main.js:31](src/main.js#L31).

## Tests

Add to [test/phase12-substrate.test.mjs](test/phase12-substrate.test.mjs) a new
sub-suite `substrate integration — cluster gather`:

1. Build a tiny graph: one `kind=cluster` node C, three function nodes a/b/c each
   with a `memberOf` edge to C.
2. Place a, b, c around C's centroid (e.g., C=(0,0), a=(100,0), b=(-100,0), c=(0,100)).
3. Emit a gather moment with `members=[a,b,c]`, target = gatherCentroid.
4. Tick 30 frames. Assert members moved toward centroid monotonically.
5. Assert legacy parity with `startClusterGather()` in the same way the two
   existing parity tests do.

No new DOM needed — this is a pure-data test.

## Out of scope

- **Shift+Space on cluster = pull cluster members toward clicked node** — the
  existing `startGroupGather` case. This works today via `selection.selected.size >= 2`
  IF the user has multi-selected first. Leave as-is; re-express as a rule in a
  follow-up once the primary cluster-gather path is proven.
- **Cluster labels becoming draggable while selected** — orthogonal to the gather
  bug. `clusterDragState` already handles cluster dragging; this fix only makes
  the cluster *selectable* for keyboard interactions.
- **Visual selection ring around the cluster label** — nice-to-have; not needed
  to fix the bug. Can piggyback on the existing `selection-changed` bus event
  that the legacy renderer already listens to.

## Risk

Low. The change is additive at the mousedown site (selection was previously
untouched, now gets populated) and additive in the dispatcher (new case before
existing cases). Existing tests that don't involve cluster labels can't regress.
The 19 substrate tests + the 2 parity tests remain green by construction.

The one thing to double-check: clicking a cluster label *while a gather is
in progress* shouldn't steal selection mid-pull. Today `gatherState` was the
guard; under the substrate it's `activeGatherMoment`. Ensure mousedown checks
`if (activeGatherMoment) return;` or accept that clicking during gather is
fine (it's a new gesture — rare edge case).

## Files changed

- [src/main.js](src/main.js) — mousedown cluster branch (selection promote),
  gather-start cases reordered with cluster path first.
- [test/phase12-substrate.test.mjs](test/phase12-substrate.test.mjs) — new cluster-gather sub-suite.

## Verification

```bash
node --test test/phase12-substrate.test.mjs    # all green including new cluster-gather tests
npm test                                        # 261+ pass, 2 pre-existing failures unchanged
```

Manual test: open a cluster'd graph, click a cluster label, press Space, hold.
Members should visibly converge toward the cluster centroid. Release Space.
Members stay; an arrangement frame is pushed.
