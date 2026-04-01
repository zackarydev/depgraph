# Depgraph Prototype Review

> This document describes the current state of `index.html` (~7600 lines, 290KB single file).
> It is structured so that each `##` heading is a **cluster**, each `- \`identifier\`` is a **node**,
> and backtick cross-references within descriptions are **edges** between nodes.
> `###` subsections are sub-clusters: they are nodes in the parent cluster AND clusters of their children.

---

## Overview: What The App Does (Step by Step)

1. **Fetch data** -- load `history.csv` (runtime recording) or fall back to source HTML for AST analysis. Also fetch a codemap markdown file for cluster definitions and importance scores.
2. **Parse** -- `parseHistoryCSV` or `analyzeCode` (acorn AST walk) produce an `analysisResult` with functions, globals, edges, and node types.
3. **Cluster** -- `clusterFunctions` assigns each node to a cluster via codemap sections, CSV cluster names, or union-find on shared state.
4. **Name & Score** -- `nameClusters` generates cluster labels from keywords; `computeAffinities` scores each node's fractional membership across clusters.
5. **Build Graph** -- `buildGraph` creates node objects (with radius, color, affinities, minZoom) and link objects (with type, weight). In hypergraph mode, structural/value nodes are created on-the-fly from edge endpoints.
6. **Layout** -- `computeLayout` runs a multi-phase pipeline: intra-cluster force simulation, deep-node positioning along edges, cluster packing, optional warm restart.
7. **Render** -- `renderGraph` does D3 data joins to create SVG elements across 6 layer groups (hulls, meta-links, links, nodes, labels, cluster-labels). Gradient edge defs, arrowheads, hulls via `d3.polygonHull`.
8. **Semantic Zoom** -- `applySemanticZoom` adjusts visibility, opacity, font size, edge layer state, and meta-edge display based on zoom level `currentK`.
9. **Interact** -- Keyboard/mouse handlers dispatch to 8+ interaction modes (attractor, click-pull, x-relax, z-time-travel, t-trace, neighbor-gather, cluster-gather, space-pull).
10. **Persist** -- Spatial memory system saves arrangement snapshots to localStorage with decay, enabling Z-time-travel and arrangement navigation.
11. **Stream** -- SSE connections enable progressive graph building: base phase (bulk), tail phase (incremental with `StreamPlacement`), end phase (settle with `GraphPhysics`).

---

## Data Pipeline

### Parsing
- `parseCSVLine`: RFC 4180 CSV parser with quote handling (line 6698)
- `parseHistoryCSV`: converts CSV rows to `{nodes, edges}` with cluster detection (line 6718)
- `buildAnalysisFromCSV`: creates `{functions, globals, nodeTypes, precomputedEdges}` for downstream pipeline (line 6792)
- `extractJS`: locate inline `<script>` tag and extract code with line offset (line 863)
- `analyzeCode`: acorn AST parse, walk declarations, extract functions/globals/calls/reads/writes (line 874)
- `parseCodemap`: parse markdown into sections with node definitions and importance scores (line 821)

### Clustering
- `clusterFunctions`: assigns nodes to clusters via codemap > CSV fallback > union-find on shared state (line 1052)
- `nameClusters`: picks cluster names from keyword frequency in member function names (line 1119)
- `computeAffinities`: scores `{cluster: weight}` per node based on shared state, calls, and keyword overlap (line 1163)
- `tokenizeName`: splits camelCase/snake_case into tokens for keyword matching (line 1044)

### Graph Construction
- `buildGraph`: master function creating nodes[] and links[] from analysis+clusters+affinities (line 1756)
  - Creates function nodes with cluster, radius, color, affinities
  - In hypergraph mode: creates structural nodes (parameter, property, value types) on-the-fly from edge endpoints
  - Structural nodes get `minZoom=10` (invisible until deep zoom)
  - Builds `adjacency`, `fullAdjacency`, `nodeDegree`, `edgeWeights` maps

---

## Edge Layer System

### Layer Configuration
- `EDGE_LAYERS`: array of `{id, color, dash, directed}` -- 8+ types: calls, calledBy, uses, writesTo, shared, sharedWrites, importance, memberOf (line ~1233)
- `ensureEdgeLayer`: auto-registers unknown edge types discovered during streaming (line 1395)
- `EDGE_TYPE_MULT` in `GraphPhysics`: force multipliers per edge type (calls=3.0, shared=1.5, etc.) (line 2530)

### Visibility & Opacity
- `pullLayerState`: `Map<layerId, opacity>` -- the single source of truth for edge layer visibility (line ~1418)
- `edgeOpacity`: computes per-edge opacity from deep-fade, layer opacity, node degree density, importance, and proximity boost at high zoom (line 1705)
- `computeHiddenNodes`: nodes hidden when ALL incident edges are in disabled layers (line 1443)
- `applyNodeHiding`: sets `display:none` on hidden nodes (line 1476)

### Zoom Breakpoints
- `ZOOM_BREAKPOINTS`: 4 presets at k=[0.3, 1.0, 4.0, 10.0] defining target layer opacities per zoom level (line 258)
- `getZoomBreakpointOpacity`: interpolates between bracketing breakpoints (line 283)
- When enabled, `applySemanticZoom` auto-adjusts `pullLayerState` to match zoom breakpoint targets (line 3112)

---

## Layout & Physics

### Initial Layout Pipeline
- `computeLayout`: orchestrator (line 1984)
  1. `layoutClusterInternal`: D3 force sim within each cluster (180 iterations) (line 2065)
  2. `positionDeepNodes`: places parameters/arguments along caller-callee edge vectors (line 2175)
  3. `packClusters`: force-based packing of cluster bounding circles (120 iterations) (line 2286)
  4. Apply cluster offsets to member nodes
  5. Optional `warmRestart`: quick D3 sim for final settling (line 2372)

### GraphPhysics (Streaming/Interactive)
- IIFE module (line 2475) with encapsulated state and spatial grid acceleration
- Per-frame `tick` computes: mass growth, grid-accelerated repulsion, edge attraction (type-weighted), cluster drift, center gravity, damping, hard collision resolution
- Settle detection: kinetic energy < 0.3*N for 90 consecutive frames
- Hull rendering throttled to every 4 frames via `HULL_EVERY_N_FRAMES` (line 2547)
- Public API: `start()`, `stop()`, `endStream(cb)`, `isRunning()`, `placeNewNode()`, `rebuildCentroids()`

### StreamPlacement
- Non-physics placement for streaming: places new nodes near existing neighbors or on graph periphery (line 2927)
- `repositionIfOrphaned`: re-places node when it gains its first edge

### Position Persistence
- `savedPositions`: `Map<id, {x,y}>` -- preserved across rebuilds (line 251)
- `stickyNodes`: `Set<id>` -- nodes user has dragged (line 252)
- `lockedNodes`: `Set<id>` -- explicitly pinned nodes (line 253)
- `initialLayoutPositions`: immutable T0 positions from last layout computation (line 314)

---

## SVG Rendering

### Layer Structure (bottom to top)
1. `gHulls`: cluster boundary polygons + textPath boundary labels
2. `gMetaLinks`: aggregated inter-cluster bezier curves with gradients
3. `gLinks`: individual edge lines + arrowheads
4. `gNodes`: node circles + secondary affinity rings
5. `gLabels`: node text labels
6. `gClusterLabels`: floating cluster name text + user cluster labels

### Initialization
- `initSVG`: creates SVG, 6 layer groups, d3 zoom behavior (scale 0.1-12x), initial transform centered at 0.8x (line 3066)

### Semantic Zoom (line 3108)
This function conflates optical scaling with navigation-level changes:
- **Zoom breakpoint auto-adjustment** of edge layer opacities (NAVIGATION)
- **Label opacity** by screen radius threshold (NAVIGATION -- information hiding)
- **Deep node fade-in** at k>=10 (NAVIGATION -- new content appears)
- **Floating cluster label** fade-out at k>2.5 (NAVIGATION)
- **TextPath boundary label** fade-in at k=3-4 (NAVIGATION)
- **Meta-edge** show/hide at k<1.5 (NAVIGATION)
- **Hull opacity** scaling (MIXED -- optical comfort + information density)
- **Edge opacity** recomputation with proximity boost (MIXED)

### Node Rendering
- `setupNodeCircle`: creates circle + rings + all event handlers (click, contextmenu, mouseenter, force touch, pressure) (line 3395)
- `renderIncremental`: D3 data join for streaming updates (line 3505)
- `renderGraph`: full rebuild with position reuse, layout, element creation (line 3587)

### Position Updates
- `renderPositions`: transforms all elements to current node x,y positions, updates gradient endpoints, arrowheads (line 4697)

---

## Cluster Visuals

### Hull Computation
- `renderHulls`: `d3.polygonHull` + `expandHull` (20px padding) + textPath labels for each cluster (line 3859)
- `expandHull`: pushes hull points outward from centroid (line 3097)
- `renderUserClusters`: dashed hulls/circles for user-defined clusters (line 3923)

### Meta-Edges
- `computeMetaLinks`: aggregates inter-cluster edges, creates gradient IDs, computes bezier curves (line 4579)
- `clusterCentroid`: weighted center of visible cluster members (line 4615)
- `renderMetaLinks`: draws bezier curves with gradients (line 4632)
- `updateMetaLinkPositions`: repositions after layout changes (line 4682)

### Cluster Labels
- `computeClusterLabelPlacement`: iterative positioning with spatial-grid collision avoidance (label-label and label-node) (line 4380)
- `applyClusterLabelPlacements`: sets `{dx, dy, angle}` on DOM elements (line 4541)
- `renderClusterLabels`: repositions floating text elements (line 4567)
- `clusterLabelDrag`: D3 drag behavior for cluster labels + invisible follower movement (line 4030)

### Cluster Importance
- `clusterImportance`: `Map<cid, scaleFactor>` -- modulates node/edge opacity per cluster (line ~4028)
- `reduceClusterImportance`: Ctrl+click scales down (line 4247)
- `growClusterImportance`: double-click scales up (line 4255)
- `applyAllClusterImportanceVisuals`: applies opacities to all nodes/edges (line 4163)

---

## Interaction

### Selection & Focus
- `selectNode`: sets `selectedNode`, opens info panel with affinity bars and struct bars (line 4852)
- `selectedNodes`: `Set<id>` for multi-select via Shift+click (line 335)
- Info panel shows: cluster affinities (bar chart), read/write/call context (struct bars)

### Attractor / Click-Pull
- `startAttractor`: force-press or shift-hold begins pulling neighbors toward held node (line 4925)
- `attractorLoop`: RAF loop with ramping strength (0-1 over 200ms), BFS depth by hold duration (line 4936)
- `clickPull`: sustained importance-weighted pull of a single node (line 5037)

### X-Relax (Rewind)
- `startXForces`: hold X to apply weak repulsion (single node or global relaxation) (line 5206)
- `dismissNodeToT0`: Shift+X+click animates node back to T0 position (line 5694)

### Z-Time-Travel
- `startZTimeTravel`: hold Z to step backward through arrangement history (line 5281)
- Animates positions to each snapshot with dwell time (`zTravelStepDuration`)
- Can pause on release, resume on re-hold

### T-Trace
- `startTrace`: BFS traversal from selected nodes through visible graph (line 5442)
- Modes: 'both', 'forward' (calls only), 'backward' (calledBy only)
- `traceLoop`: RAF stepping BFS frontier every `traceEdgeDuration` ms (line 5541)
- Flash mode: quick-tap visualizes full BFS instantly
- H key: persist trace visuals after T release

### Space-Gather
- `startNeighborGather`: Space+click pulls 1-depth neighbors toward anchor (line 5723)
- `startClusterGather`: Space+drag cluster label gathers all cluster members (line 5945)
- `startIntraClusterGather`: Shift+Space+label for within-cluster-only gather (line 6102)
- `startSpacePull`: Space+Shift+click pulls selected nodes toward target (line 6165)

---

## Navigation vs Zoom: Analysis

The d3 zoom transform is a pure optical scaling (line 3081-3094). But `applySemanticZoom` (line 3108) bolts **navigation semantics** onto it, making zoom level change WHAT you see, not just HOW you see it.

| Behavior | Optical (transform) | Navigation (content change) |
|---|---|---|
| Pan/scroll | YES | no |
| Scale factor | YES | no |
| Zoom breakpoints change layer visibility | no | YES |
| Label opacity thresholds | no | YES (info hiding) |
| Deep node fade-in (k>10) | no | YES (new content) |
| Meta-edge show/hide (k<1.5) | no | YES |
| Floating label fade-out (k>2.5) | no | YES |
| TextPath label fade-in (k=3-4) | no | YES |
| Hull opacity scaling | partial | partial |
| Edge proximity boost (k>=3) | partial | partial |

**The problem**: zoom is the ONLY way to navigate the hypergraph depth. There is no concept of "enter this cluster" or "go up a level" independent of the optical zoom. The zoom breakpoints (Overview at 0.3, Systems at 1.0, Structural at 4.0, Deep at 10.0) are de facto navigation levels masquerading as optical comfort settings.

**What hypergraph navigation should be**: A discrete operation -- "expand this cluster into its members" or "collapse these nodes into their cluster" -- that changes the graph topology, not the camera. Zoom could then be purely optical. The breakpoints would become navigation-level transitions triggered by zoom OR by explicit user action (click to enter, back to exit).

**Where zoom is tightly coupled to functionality** (all in `applySemanticZoom`, line 3108):
- Line 3112-3126: zoom breakpoints mutate `pullLayerState` (edge visibility)
- Line 3151: deep node opacity = `(k - minZoom) / 2` -- hard-coupled to zoom level
- Line 3162-3164: deep node pointer-events disabled below opacity threshold
- Line 3200-3206: meta-edges displayed only at k < 1.5
- Line 3178-3185: textPath labels tied to k=3-4 range
- Line 3248-3251: hull recomputation triggered by crossing k=10

---

## Event Handling

### Keyboard Dispatch (line 6263)
15+ active keys with complex modifier combinations:
- **Escape**: clear search, deselect, close panels
- **P**: pause/resume stream
- **Space**: cluster gather, neighbor gather, space-pull, unlock (context-dependent)
- **X**: hold for relax/repulsion; Shift+X+click for dismiss-to-T0
- **Z**: hold for time-travel backward through arrangements
- **T**: hold for trace BFS; T+B for backward, T+F for forward, H to persist
- **Alt+Left/Right**: arrangement navigation
- **Enter**: create user cluster from selection

### Mouse/Touch
- Drag: node repositioning with soft collision (line 3309)
- Force press (Safari) / Pointer pressure (Chrome): attractor activation (line 3448-3478, 6474-6507)
- Shift+drag: multi-select group movement
- Ctrl+click: reduce cluster importance
- Double-click: grow cluster importance
- Right-click: spatial repulsion bubble

---

## Streaming & Live Reload

### SSE Connections
- `connectStreamSSE`: progressive graph building from history.csv stream (line 6874)
  - Phase 1 (base): accumulate bulk rows, then rebuild
  - Phase 2 (tail): incremental with `StreamPlacement`
  - Phase 3 (end): finalize with `GraphPhysics` settle
- `connectGraphSSE`: bulk graph update events triggering `loadAndAnalyze` (line 6824)
- `connectFocusSSE`: step-by-step debug focus events (line 7384)

### Cinematic Mode
- `CinematicStream`: queues rows and animates zoom-tour through new visible nodes (line 7230)
- D3 transitions to zoom to each node with stroke animation highlight

---

## Spatial Memory

- `spatialMemory`: `{arrangements: [], spatialEdges: {}, clickLog: []}` persisted to localStorage (line 580)
- `pushArrangement`: saves current node positions, cluster importance, and focal nodes (line 628)
- `navigateArrangement`: step through history with position interpolation (line 669)
- `enterComparisonMode`: side-by-side when oscillation detected (3+ back-and-forth navigations) (line 702)
- `trackClickCoOccurrence` / `trackDragProximity`: record affinity signals (lines 744, 763)
- Spatial decay: half-life of 1 week (line 239)

---

## Anomalies

### Bugs

- `HULL_EVERY_N_FRAMES` defined inside GraphPhysics IIFE (line 2547) but `renderPositions()` (line 4697) calls `renderHulls()` unconditionally on every frame outside physics. The throttling only applies during physics ticks.
- `traceRAF = -1` sentinel (line ~5532): fragile pattern. If any code path forgets the `!== -1` check when calling `cancelAnimationFrame`, the animation leaks silently.
- **Timer leak in trace flash**: `setTimeout` callbacks (line ~5504) for flash wave visualization are never cancelled on Escape/stopTrace. Pending timeouts fire and apply trace visuals to a cleared graph.
- **Label placement timer fires on stale data**: `labelPlacementTimer` (line 3189) set inside `applySemanticZoom` can fire AFTER `rebuild()` replaces the graph, computing placement for nodes that no longer exist.
- **Attractor loop unbounded**: `attractorLoop` (line 4936) has no maximum duration. After 1500ms `maxHop` locks at 3, but the loop runs indefinitely until user release.
- **clusterGatherAnchorCid stale**: if `startClusterGather` returns early due to existing RAF, the anchor CID from the previous gather persists.
- **currentHullClusterIds divergence**: computed differently in `renderIncremental` (line ~3568) vs layer slider toggle (line ~1577). Can diverge.

### Duplicate Functionality

These are places where the same concept is implemented in two or more divergent ways:

**1. Cluster Centroid -- two implementations**
- `GraphPhysics.rebuildCentroids()` (line 2552): iterates `currentNodes`, skips invisible, computes `{sx, sy, count}` per clusterName
- `clusterCentroid(cid)` (line 4615): filters `currentNodes` by cluster ID, computes weighted average
- These compute the same thing from different filtering logic (clusterName vs cluster ID). They can return different results for the same cluster.

**2. Edge Opacity -- computed in two places**
- `edgeOpacity()` function (line 1705): comprehensive computation with deep-fade, layer state, density, importance, proximity boost
- `applySemanticZoom()` inline (line 3217): calls `edgeOpacity` but also does its own display toggling and trace-edge filtering
- The logic for "should this edge be visible" is split between the two.

**3. Node Visibility -- 4+ mechanisms**
- `_hiddenNodes` set from `computeHiddenNodes()` (line 1443): based on edge layer state
- `applySemanticZoom` deep-node opacity (line 3160): based on zoom level and `minZoom`
- `applySemanticZoom` pointer-events disable (line 3164): when `deepOp < 0.1`
- Search handler (line 6554): directly sets opacity on nodes/labels
- Trace mode: adds CSS classes for glow/dim
- Each mechanism operates independently. Combined visibility = product of all mechanisms, but there's no single query for "is this node visible?"

**4. renderHulls() + renderClusterLabels() -- bundled in 6+ call sites**
- Lines 1578, 1619, 2868, 3251, 3794, 4747, 6611
- Always called together but never abstracted into one call. If hull rendering ever needs to happen without label recomputation, all 6+ sites need updating.

**5. Highlight/reset -- 3 implementations**
- `clearHighlight()`: resets opacity, calls `applySemanticZoom` + `applyNodeHiding`
- Search clear: calls `clearHighlight()`
- Trace stop: calls `clearTraceVisuals()` which also resets via `applySemanticZoom`
- Each takes a different path to "restore default visibility."

**6. Position saving -- 3 separate triggers**
- `renderGraph()` line ~3593: saves positions before layout
- `nodeDrag.on('end')`: saves dragged node position
- `animateToPositions` completion: saves all final positions
- `stopXForces` / `stopZTimeTravel`: saves moved nodes
- These can conflict if multiple save paths execute in the same frame.

**7. Soft collision -- similar math in 4 places**
- `softCollide()` (line 432): general-purpose collision check/push
- `clickPull()` (line ~5071): inline collision with slightly different parameters
- `attractorLoop()` (line ~4960): inline push-away for non-neighbors
- Various gather functions: inline collision logic
- All compute distance, check overlap, push proportionally. Small variations in padding, strength, and which nodes participate.

**8. Cluster member filtering -- repeated pattern**
- `currentNodes.filter(n => n.cluster === cid)` appears in 10+ places
- `clusterMemberCache` (line 513) exists for this purpose but is only used in label placement
- Most call sites compute this filter inline instead of using the cache.

### Parallel State That Drifts

**savedPositions vs stickyNodes vs lockedNodes**
- `savedPositions` (Map): stores x,y coordinates, survives rebuilds
- `stickyNodes` (Set): boolean flag for "user moved this", survives rebuilds
- `lockedNodes` (Set): boolean flag for "user pinned this"
- On view mode change (line 6592): `stickyNodes.clear()` and `savedPositions.clear()` but `lockedNodes` is NOT cleared
- A node can be in `lockedNodes` but not `stickyNodes`, or have saved positions but not be sticky
- There's no invariant enforced between these three

**selectedNode vs selectedNodes**
- `selectedNode` (single): for info panel, set by `selectNode()`
- `selectedNodes` (Set): for multi-select, set by Shift+click
- These are independent. You can have a single `selectedNode` that's not in `selectedNodes`, or multi-selected nodes with no `selectedNode`.

### Uncoordinated Animation Loops

13+ independent `requestAnimationFrame` chains, each calling `renderPositions()`:
- `GraphPhysics.tick` / `springLoop` / `attractorLoop` / `clickPullStep`
- `xLoop` / `zLoop` / `traceLoop`
- `neighborGatherLoop` / `clusterGatherLoop` / `intraClusterGatherLoop` / `spacePullLoop`
- `animateToPositions` / per-node `xDismissRAFs`

**Problems:**
1. Multiple loops calling `renderPositions()` in the same frame = redundant DOM writes
2. No priority system -- if attractor and gather run simultaneously, they both modify node positions with conflicting forces
3. `isUserInteracting()` (line ~401) is a flat OR guard but doesn't prevent all conflicts
4. Each loop has its own cleanup logic; missing cleanup in one leaks into the next interaction

---

## Node-Cluster Duality: Analysis

### Current Model
- Nodes have a `cluster` property (integer ID). Clusters are IMPLICIT -- they exist only as a property value.
- There is no "cluster object" with its own position, radius, or state.
- Hulls are computed dynamically from member node positions.
- `clusterImportance` Map is the closest thing to "cluster as entity."
- User clusters (`userClusterSections`) are a parallel concept with different storage and rendering.

### What Hypergraph Navigation Demands
At zoom level N, a cluster should appear as a single node. Zoom into it, and it expands to show its member nodes, which may themselves be clusters at a deeper level. This is the **fundamental operation that is missing**.

The current code has the pieces:
- `minZoom` on deep nodes (structural nodes invisible until k=10)
- Cluster importance scaling that shrinks/fades clusters
- Meta-edges that connect clusters as if they were nodes
- Hull rendering that visually groups members

But these pieces are not unified into a single recursive data structure. Currently:
- You can't click a cluster to "enter" it
- You can't collapse a cluster into a single node
- The transition from "see hull" to "see members" is purely opacity-based, not topological
- Meta-edges and individual edges are rendered in completely separate layers with no transition between them

### Recommended Unification
A cluster node should be a node that contains other nodes. When collapsed, it acts as a single node in the graph (with meta-edges as its connections). When expanded, its children become visible and its hull becomes the boundary. The expand/collapse operation should be independent of zoom -- zoom changes the camera, expand/collapse changes the topology.

---

## Hypergraph Concept Isolation

### What Makes This a Hypergraph (Not Just a Graph)

1. **N-ary relations**: a shared global variable connects ALL functions that read/write it. Currently modeled as pairwise edges, but the underlying relation is N-ary. A proper hyperedge would draw one "edge" connecting all participants.
2. **Typed, dynamic edge layers**: the pull-layer system treats edge types as first-class with opacity and physics participation.
3. **Multi-cluster membership**: affinities give each node fractional membership in multiple clusters. Primary cluster is just argmax.
4. **Zoom-dependent projection**: at each zoom level, you see a different projection. Low zoom contracts clusters into nodes. High zoom reveals internals. This IS hypergraph contraction/expansion, just implemented as opacity heuristics.

### What Needs Isolation

The hypergraph data model (nodes, edges, containment, projections) should be cleanly separated from:
- **Rendering**: SVG element creation, D3 selections, gradient computation
- **Physics**: force simulation, collision detection, position integration
- **Interaction**: drag handlers, keyboard dispatch, selection state
- **Navigation**: zoom level interpretation, expand/collapse, breakpoint transitions
- **Persistence**: spatial memory, arrangement history, localStorage

Currently all of these are tangled in `applySemanticZoom` (which does rendering + navigation + edge visibility), `renderGraph` (which does data construction + layout + SVG creation), and the various gather/attractor loops (which do physics + interaction + rendering).

---

## Recommended File Split

| File | Responsibility | Key Functions |
|---|---|---|
| `core/types.js` | Node, Edge, Cluster, HyperEdge type definitions | (type comments/JSDoc) |
| `core/state.js` | All 40+ global state variables, centralized | exported state object |
| `core/animation.js` | Central RAF scheduler, replaces 13 independent loops | `registerLoop`, `tick`, single `renderPositions` per frame |
| `data/parse.js` | CSV + AST + codemap parsing | `parseCSVLine`, `parseHistoryCSV`, `analyzeCode`, `parseCodemap` |
| `data/cluster.js` | Clustering, naming, affinity scoring | `clusterFunctions`, `nameClusters`, `computeAffinities` |
| `data/graph-builder.js` | Node/link creation from analysis | `buildGraph` |
| `edges/layers.js` | Edge layer config, pull-layer state, UI sliders | `EDGE_LAYERS`, `pullLayerState`, `initPullLayerUI`, `edgeOpacity` |
| `edges/visibility.js` | Unified visibility: hidden nodes + deep fade + search + trace | `isNodeVisible(node)` -- single query |
| `layout/physics.js` | GraphPhysics module extracted as class | force tick, spatial grid, settle detection |
| `layout/placement.js` | StreamPlacement, initial layout, cluster packing | `computeLayout`, `placeNewNode` |
| `layout/positions.js` | Position persistence: savedPositions + sticky + locked (UNIFIED) | `savePosition`, `isSticky`, `isLocked` |
| `render/svg.js` | SVG init, layer groups, zoom behavior | `initSVG` |
| `render/nodes.js` | Node circle creation, data joins | `setupNodeCircle`, `renderIncremental` |
| `render/edges.js` | Edge lines, gradients, arrowheads | edge rendering from `renderGraph` |
| `render/hulls.js` | Hull computation, expansion, textPath labels | `renderHulls`, `expandHull` |
| `render/meta-edges.js` | Meta-link computation, bezier curves, centroids | `computeMetaLinks`, `clusterCentroid` (UNIFIED) |
| `render/labels.js` | Node labels, cluster labels, label placement | `computeClusterLabelPlacement`, `renderClusterLabels` |
| `render/positions.js` | `renderPositions` -- transform all elements | single render call per frame |
| `navigation/semantic-zoom.js` | Zoom-to-navigation-level mapping, breakpoints | `applySemanticZoom` (STRIPPED of rendering) |
| `navigation/expand-collapse.js` | Future: cluster expand/collapse topology changes | `expandCluster`, `collapseCluster` |
| `interact/select.js` | Selection, info panel, multi-select | `selectNode`, `selectedNodes` |
| `interact/attractor.js` | Force press, attractor loop | `startAttractor`, `attractorLoop` |
| `interact/forces.js` | X-relax, click-pull, dismiss-to-T0 | `startXForces`, `clickPull`, `dismissNodeToT0` |
| `interact/trace.js` | T-trace BFS, flash, hold, mode switching | `startTrace`, `traceLoop` |
| `interact/gather.js` | All gather variants: neighbor, cluster, intra, space-pull | `startNeighborGather`, `startClusterGather`, etc. |
| `interact/keyboard.js` | Keydown/keyup dispatch | delegates to interaction modules |
| `spatial/memory.js` | Arrangement history, decay, comparison mode | `pushArrangement`, `navigateArrangement` |
| `spatial/time-travel.js` | Z-key arrangement stepping | `startZTimeTravel` |
| `stream/sse.js` | SSE connections, stream phases | `connectStreamSSE`, `connectGraphSSE` |
| `stream/cinematic.js` | CinematicStream zoom-tour | `CinematicStream` |
| `main.js` | Init pipeline, `rebuild`, polling | `loadAndAnalyze`, `initDataPipeline` |

### Key Architectural Changes in the Split

1. **Central animation scheduler** (`core/animation.js`): All interaction loops register their per-frame update function. Scheduler calls all active updaters, then `renderPositions()` exactly ONCE. Eliminates redundant DOM writes and conflicting forces.

2. **Unified visibility** (`edges/visibility.js`): Single `isNodeVisible(node)` function that combines hidden-nodes, deep-fade, search, and trace state. All rendering checks this one function.

3. **Unified position persistence** (`layout/positions.js`): Merge `savedPositions`, `stickyNodes`, and `lockedNodes` into one `PositionState` per node: `{x, y, sticky: bool, locked: bool}`. Single source of truth.

4. **Unified cluster centroid** (`render/meta-edges.js`): One `clusterCentroid(cid)` function used by both physics and meta-edge rendering. No more divergent implementations.

5. **Navigation separated from rendering** (`navigation/semantic-zoom.js`): Computes the navigation level from zoom, but doesn't touch the DOM. Returns a `NavigationState` that the rendering modules consume.
