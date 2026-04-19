# Property Listeners + Spatial Index + Zoom Caching

Session log: introducing system-property listeners as a first-class substrate,
then using the pattern to clean up `computeSpatialEdges` and cache
`applySemanticZoom`.

## Motivation

[drag.js:147](src/interact/drag.js#L147), the prior `computeSpatialEdges`,
iterated every entry in `posMap.positions` for each dragged node — O(N) per
node, O(N²) on group drag. It also walked slot nodes, sentinels, and anything
else with a `PositionState`, producing `spatial:*` edges pointing at slots.

The real discussion was architectural, not just about this one function:
there is no "catch" layer for system-recognized node properties. The renderer
maintains its own element maps, drag walks posMap, spatial edges walk posMap,
and every consumer redoes the classification work ad-hoc.

## What was built

### 1. Property listener substrate — [src/core/properties.js](src/core/properties.js)

A registry of hardcoded-in-JS predicates that classify nodes as rows flow
through. Each listener holds a live `Map<id, Node>` of references into
`graph.state.nodes` (not copies), so consumers see the same objects as the
canonical state.

```
createPropertyRegistry() -> { listeners }
registerProperty(registry, spec)
getProperty(registry, name) -> PropertyListener | null
notifyRow(registry, row, state)
resetProperties(registry)
```

A spec supplies any of `onNodeAdd / onNodeUpdate / onNodeRemove /
onEdgeAdd / onEdgeRemove / onReset`. Listeners own their internal bookkeeping
(counters, flags) and mutate their `nodes` map directly.

### 2. `spatial` property — [src/rules/spatial.js](src/rules/spatial.js)

History-driven (option B, confirmed in conversation): a node is spatial iff
it has both an x-layer and y-layer slot edge outgoing. Matches the
`positionRows` shape emitted by drag / reset. Slot nodes themselves never
qualify — they're targets, not sources, of x/y edges.

Internally maintains `xCount: Map<id, number>` and `yCount: Map<id, number>`
and admits/evicts on edge add/remove.

### 3. Graph wiring — [src/data/graph-builder.js](src/data/graph-builder.js)

`buildFromHistory(rows, W, properties?)` and `applyRowToGraph` now notify the
registry after each state mutation. The registry is stored on the graph so
incremental updates don't need it passed through.

### 4. Quadtree K-NN — [src/layout/quadtree.js](src/layout/quadtree.js)

Existing `nearest()` was `collectAll + sort`, which defeats the tree. Replaced
with a bounded max-heap traversal that prunes quads whose closest-possible
distance exceeds the current k-th best. Visits children in proximity order.
Takes an optional `filter` so callers can exclude the probe node itself.

### 5. `computeSpatialEdges` rewrite — [src/interact/drag.js](src/interact/drag.js)

- Consumes `opts.spatial` (the listener) instead of `posMap.positions`.
- Builds a quadtree over spatial nodes **once per drag**, reused across all
  dragged nodes for group drags.
- Uses the new `nearest()` with a filter to exclude the source node.
- Naturally excludes slot nodes and sentinels (they don't qualify for the
  spatial property).

### 6. `applySemanticZoom` caching — [src/render/v3.js](src/render/v3.js#L667)

Mid-session pivot: the user pointed out that spatial-edge emission on
drag-end is buggy, and that the bigger perf win was zoom, where each wheel
event fires `setAttribute` on every label (≈1.42ms each).

Applied the same pattern `renderPositionsOnly` uses:

- Per-element cache: `_lastOp`, `_lastFs`, `_lastFillOp`, `_lastStrokeOp`.
  `setAttrIfChanged()` compares the cached value and only calls
  `setAttribute` when it changes.
- Top-level signature short-circuit: stable k (within `K_EPS = 1e-3`) and
  unchanged flags + element counts → return immediately.

Because the computed opacity / font-size is identical across all labels
(pure function of `k`), a stable zoom level performs 0 DOM writes after the
first settle.

### 7. `main.js` wiring — [src/main.js](src/main.js)

- Creates `createPropertyRegistry()`, registers `createSpatialProperty()`.
- Threads the registry through `buildFromHistory`.
- Stashes the spatial listener via `getProperty(properties, SPATIAL_PROPERTY)`
  and passes it as `{ spatial }` to `endDrag`.

## Design decisions

**Why B (history-driven spatial) over A (posMap-driven):** Confirmed in
conversation. The listener reconstructs purely from history rows, matching
the "pointers to the history object" framing. Slot nodes are excluded
automatically. Replay is a pure function of history.

**Why not use the spatial listener in `applySemanticZoom`:** the renderer's
own element maps are a tighter subset (only nodes with a DOM element). The
listener would be useful for *creation* (deciding which nodes get elements),
not for *update* iteration. The user noted this was interesting but went
with per-element caching instead.

**Why per-element `_lastX` pattern instead of CSS custom properties:**
discussed briefly. `setProperty('--k', k)` + `calc()` is elegant but still
triggers style recalc and won't reliably beat a per-element branch for the
common "nothing changed" case. Performance probably comparable; the cache
pattern matches the existing `renderPositionsOnly` idiom.

## Known test drift (pre-existing, unrelated)

Three tests were failing before any of this work (verified by inspection,
not by reverting):

- `phase6-interact.test.mjs:201` — expects NODE rows from `endDrag` to carry
  `_payload.action`. Matches the deleted `src/data/payload-expand.js` in
  `git status`.
- `phase6-interact.test.mjs:432` — `resetSingleNode` returning `[]` where
  `null` was expected.
- `phase12-substrate.test.mjs:425` — expects `Set(['a','b'])` but the
  `mouse-clicked` sentinel (seeded at init time) appears in the cluster
  member resolution.

None of these intersect the property-listener / quadtree / zoom changes.

## Files touched

- **new** [src/core/properties.js](src/core/properties.js)
- **new** [src/rules/spatial.js](src/rules/spatial.js)
- [src/data/graph-builder.js](src/data/graph-builder.js) — registry wiring
- [src/layout/quadtree.js](src/layout/quadtree.js) — real K-NN pruning
- [src/interact/drag.js](src/interact/drag.js) — spatial-listener + quadtree
- [src/render/v3.js](src/render/v3.js) — zoom caching
- [src/main.js](src/main.js) — registry init + endDrag threading

## Follow-ups worth considering

- Wire the spatial listener into `renderFull` so element creation itself
  derives from `spatial.nodes` rather than separate iteration of
  `graph.state.nodes`. Closes the loop on the user's vision of the renderer
  being a pure consumer of property listeners.
- Move spatial-edge emission off `endDrag` (still buggy in ways we didn't
  chase this session — user flagged drag-end as a poor trigger; zoom events
  might be a cleaner moment to snapshot "what's close").
- Register additional properties (`selected`, `focal`, `hoverable`, etc.)
  so other subsystems can subscribe instead of scanning state.
