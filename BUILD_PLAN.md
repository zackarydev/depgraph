# Build Plan — Depgraph v1 Rebuild

> This plan turns [SPEC.md](SPEC.md) into shipped code. Each phase produces a **testable artifact** before the next begins. Phases are sequential (each depends on the prior), but tasks within a phase can run in parallel.
>
> Reference: [SPEC.md §18](SPEC.md) for the high-level checklist; this plan adds concrete files, acceptance criteria, test strategies, and dependency ordering.
>
> **The old prototype (`depgraph-v0`) lives at `../depgraph-v0/` and is not part of this build.** Do not reference it during implementation — this plan and the SPEC are the only inputs. The old code exists on-demand if you're ever curious about how something *used to* work, but reading it risks importing the exact biases this rebuild is designed to escape.

---

## Testing Rule — The Only Rule

A phase is **not done** until it ships a test file under `test/` that encodes its acceptance criteria as runnable assertions. `npm test` runs **all** test files from **all** completed phases. If any prior phase's tests break, the current phase is not shippable.

```
test/
  phase1-core.test.mjs       ← bus, scheduler, state
  phase2-history.test.mjs    ← cursor, branches, snapshot, round-trip
  phase3-derive.test.mjs     ← hyperedges, affinities, dirty propagation, W-cascade
  phase4-layout.test.mjs     ← gradient descent convergence, quadtree, sticky/locked
  phase5-render.test.mjs     ← DOM element counts, viewport culling, visibility query
  phase6-interact.test.mjs   ← each mode writes history, Z-undo reverses it
  phase7-stream.test.mjs     ← offline works, SSE works, both-off works
  phase8-context.test.mjs    ← W change shifts clusters, presets round-trip
  phase9-scale.test.mjs      ← 10k nodes at 60fps, dirty recompute count < 50
  phase10-produce.test.mjs   ← producers emit valid history rows
  phase11-rules.test.mjs     ← match, apply, transaction undo, branch on multi-binding
  phase12-agent.test.mjs     ← read/append/explain round-trip via HTTP
```

**Why this works:** each test file is small (50–200 lines), tests only that phase's contracts, and runs in < 5 seconds. The full suite runs in < 30 seconds. If Phase 6 introduces a regression in Phase 3's derivation, the build stops immediately — not 3 phases later when the bug becomes mysterious.

**What counts as a test:** a `node --test` assertion that fails loudly. Not "open the browser and look." Browser-dependent tests (Phase 5 rendering, Phase 9 fps) use a headless check or a separate `test:visual` script, but the core contracts (history, derivation, layout convergence) are pure Node.js.

**Gate rule:** before starting Phase N+1, run `npm test`. All green or no forward progress.

---

## Phase 0 — Scaffold & Types

**Goal:** Empty module tree exists. Types compile. Nothing runs yet.

| Task | Files | Done when |
|---|---|---|
| Create `src/` directory tree per §6 | all dirs | `ls -R src/` matches the module map |
| Write JSDoc type definitions | `core/types.js` | `Node`, `Edge`, `HistoryRow`, `WorkingContext`, `PositionState`, `RewriteRule` types defined |
| Stub every module (empty named exports) | all `.js` files | `import * from` every module without error |
| `index.html` shell | `index.html` | Loads D3, imports `main.js`, blank SVG viewport |

**Test:** `node --check src/**/*.js` passes. `index.html` opens with no console errors.

**Estimated effort:** Small. Foundation only.

---

## Phase 1 — Core Runtime (no UI)

**Goal:** The event bus, animation scheduler, and state container work. A single RAF loop ticks.

### 1a. State container
- `core/state.js` — single `State` object with `nodes: Map`, `edges: Map`, `cursor`, `context`.
- Reducers: `applyRow(state, row)` → new state. Pure function.
- **Test:** unit test: feed 10 history rows, assert derived maps match.

### 1b. Event bus
- `core/bus.js` — typed pub/sub: `bus.emit('cursor-moved', {from, to})`, `bus.on(...)`.
- Events: `cursor-moved`, `context-changed`, `row-appended`, `rebuild`, `selection-changed`.
- **Test:** unit test: subscribe, emit, assert callback fired with payload.

### 1c. Animation scheduler
- `core/animation.js` — `scheduler.register(name, tickFn)`, `scheduler.unregister(name)`, single RAF loop calls all registered ticks, then calls `renderPositions()` exactly once.
- **Test:** register two dummy ticks, confirm both fire per frame, confirm render fires once.

**Phase 1 acceptance:** `main.js` boots, subscribes a dummy tick, logs "tick N" to console every frame. No DOM beyond the blank SVG.

---

## Phase 2 — Unified History (the foundation)

**Goal:** History is the single source of truth. Cursor moves. Branches work. No UI yet.

### 2a. CSV parser
- `data/csv.js` — RFC 4180 reader + writer. Streaming line-by-line reader for large files.
- **Test:** round-trip: write 1000 rows, read back, assert equality. Test quoted fields, commas in values.

### 2b. History log
- `data/history.js`:
  - `load(csvString)` → builds internal row array + index.
  - `append(row)` → validates schema, assigns `t`, appends.
  - `cursor` getter/setter. Moving cursor rebuilds derived state via `state.applyRow`.
  - `branch(atCursor)` → forks history. `branches()` → list. `switchBranch(id)`.
- **Test:** unit test:
  1. Load 50 rows. Assert cursor = 50.
  2. Move cursor to 25. Assert derived state matches first 25 rows only.
  3. Append a row at cursor 25. Assert branch created. Cursor now on branch.
  4. Switch back to main. Assert cursor 50 state restored.

### 2c. Snapshot
- `data/snapshot.js` — `writeSnapshot(state, cursor)` → JSON. `loadSnapshot(json)` → state + cursor. `loadWithTail(snapshotJson, tailCsv)` → full state.
- **Test:** load 1000 rows, snapshot at 500, load snapshot + tail rows 501–1000, assert identical state to full replay.

**Phase 2 acceptance:** `history.test.mjs` passes. Time travel (cursor move) works in isolation with no DOM. Branch creation/switching passes.

---

## Phase 3 — Derivation Engine

**Goal:** Given history rows + weight vector `W`, produce derived hyperedges, affinities, clusters. Changing `W` changes clusters.

### 3a. Graph builder
- `data/graph-builder.js` — `buildFromHistory(rows)` → `{nodes: Map, edges: Map}`. Replays rows applying `add/update/remove` ops.
- **Test:** 20 NODE add + 30 EDGE add rows → correct maps. Then 2 EDGE remove → maps updated.

### 3b. Derive
- `data/derive.js`:
  - `deriveHyperEdges(edges)` → group edges by shared member into equivalence classes.
  - `deriveAffinities(node, edges, W)` → `Map<groupId, weight>`, sums to 1.
  - `deriveClusters(nodes, affinities)` → promote top-level hyperedges into cluster nodes with `memberOf` edges.
  - Dirty propagation: `invalidate(edgeId)` marks affected nodes/hyperedges; `recompute()` only processes dirty set.
- **Test:**
  1. Build graph. Derive affinities with default `W`. Assert primary clusters.
  2. Change `W` (boost `calls` to 10.0, set `memberOf` to 0.1). Re-derive. Assert primary clusters shifted.
  3. Add one edge. Assert only its two endpoints' affinities recomputed (dirty propagation).

### 3c. Context
- `core/context.js` — `WorkingContext` creation, presets (`code-review`, `refactor`, `debug`), serialization.
- `context.setWeights(W)` → emits `context-changed` on bus → triggers `derive.recompute()`.
- **Test:** switch from `code-review` preset to `refactor` preset, assert affinities change.

**Phase 3 acceptance:** console demo: load a real history.csv (from current runtime/), print derived clusters, change W, print changed clusters. No DOM.

---

## Phase 4 — Placement & Layout

**Goal:** Nodes have 2D positions computed by gradient descent on the energy manifold. Graph settles.

### 4a. Quadtree
- `layout/quadtree.js` — Barnes-Hut 2D spatial index. Insert/remove/rebuild. `approximateRepulsion(node, theta)` → force vector. Nearest-neighbor query. Interface is octree-swappable (3D-ready).
- **Test:** insert 5000 random points, query nearest 10 for a probe point, assert correctness vs brute force.

### 4b. Energy + gradient
- `layout/gradient.js`:
  - `E(positions, edges, W, context)` — returns scalar energy.
  - `gradE(positions, edges, W, context)` — returns per-node gradient vectors.
  - Terms: edge attraction (weight × layer), quadtree repulsion, pin constraints, hull boundary penalties.
- `layout/manifold.js` — `project(latentPositions)` → 2D. Initial implementation: stress-majorization using graph-distance targets.
- **Test:** 50 nodes, 100 edges. Run 200 descent steps. Assert energy decreases monotonically. Assert converges (`||gradE|| < epsilon`).

### 4c. Positions
- `layout/positions.js` — `PositionState = {x, y, t0x, t0y, sticky, locked}` per node. Clamping: sticky dampens gradient, locked zeroes it.
- **Test:** lock node A, run 50 descent steps, assert A hasn't moved. Sticky node B moves < 10% of a free node.

### 4d. Placement
- `layout/placement.js`:
  - `initialPlace(nodes, edges, W)` — full descent to settle.
  - `streamPlace(newNode, existingPositions)` — seed at neighbor centroid, brief local descent.
- **Test:** add a new node to a settled graph, assert it converges near its neighbors within 30 steps.

### 4e. Warm restart
- `layout/warm-restart.js` — after a rebuild (new rows), run short descent (60 steps max) from current positions. Sticky nodes stay.
- **Test:** settled graph + 5 new nodes. Warm restart. Old nodes move < 5px avg. New nodes settled.

**Phase 4 acceptance:** console + minimal SVG: render 200 nodes, watch gradient descent settle, drag a node (set position), see neighbors adjust.

---

## Phase 5 — Rendering

**Goal:** Full visual output. Fractal recursive rendering. Viewport culling.

### 5a. SVG init + viewport
- `render/svg.js` — create SVG, 6 layer groups, D3 zoom (0.1–12x).
- `render/viewport.js` — query quadtree for visible set + 200px halo. Cull non-visible elements from DOM.
- **Test:** 5000 nodes. Only ~200 DOM elements when zoomed in. Assert via `document.querySelectorAll('circle').length`.

### 5b. Nodes + edges
- `render/nodes.js` — D3 data join for circles + affinity rings. Event wiring (click, drag, force-press).
- `render/edges.js` — lines, gradients, arrowheads. Layer coloring from `edges/layers.js`.
- **Test:** render 100 nodes + 200 edges. Assert all visible. Assert layer toggle hides subset.

### 5c. Hulls + meta-edges + labels
- `render/hulls.js` — `d3.polygonHull` + expand + textPath boundary labels. Recursive per expanded cluster.
- `render/meta-edges.js` — bezier gradients between cluster centroids. `clusterCentroid()` (single implementation).
- `render/labels.js` — node labels + floating cluster labels + collision-aware placement.
- **Test:** 5 clusters, each with 10 nodes. Hulls visible. Meta-edges connect clusters. Labels don't overlap.

### 5d. Fractal rendering
- Recursive `renderGraph(nodesAtDepth, edgesAtDepth, depth)` per §5.
- Screen-radius LOD: clusters expand when on-screen radius > 80px, stay collapsed when pinned.
- **Test:** 2-level hierarchy. Zoom in on one cluster. Assert its members appear. Assert sibling clusters stay as single nodes. Pin a cluster collapsed, zoom in, assert it stays a dot.

### 5e. Visibility
- `edges/visibility.js` — `isVisible(node, context, cursor)`. Single function. Used by all renderers.
- `edges/opacity.js` — `edgeOpacity(edge, context)`. Single function.
- `edges/layers.js` — layer registry, per-layer opacity slider UI.
- **Test:** toggle a layer off, assert `isVisible` returns false for nodes only connected via that layer.

### 5f. Render pump
- `render/positions.js` — `renderPositions()` transforms all visible elements. Called once per frame by scheduler.
- **Test:** register two interaction ticks + render. Assert `renderPositions` fires exactly once per frame (instrument with counter).

**Phase 5 acceptance:** open `index.html`, see the current depgraph codebase rendered with clusters, edges, labels. Zoom in/out with fractal LOD. 60fps at 1k nodes.

---

## Phase 6 — Interaction

**Goal:** All user controls from [docs/controls.md](docs/controls.md) work. Every action writes to history.

### 6a. Select + drag
- `interact/select.js` — click → select, Shift+click → multi-select, info panel.
- `interact/drag.js` — drag node → update position → append history row. Group drag.
- **Test:** drag node. Assert history row appended. Undo (Z) restores position.

### 6b. Gather (unified)
- `interact/gather.js` — one engine handles all variants: neighbor gather, cluster gather, intra-cluster, space-pull. Each adds a temporary attraction term to `E`.
- **Test:** select 3 nodes, hold Space, assert they converge. Release, assert term removed, nodes stay.

### 6c. Attractor
- `interact/attractor.js` — force-press or shift-hold. Ramps attraction strength. BFS depth by hold duration.
- **Test:** hold on node A. Assert neighbors pulled toward A over 2 seconds.

### 6d. Trace
- `interact/trace.js` — T for BFS. Forward (T+F), backward (T+B), both. Flash (tap). Hold (H).
- **Test:** tap T. Assert BFS wave reaches 3-hop neighbors. Press H, release T, assert trace persists. Escape clears.

### 6e. X-reset
- `interact/reset.js` — hold X → positions decay toward T0, weights toward context defaults. NOT a cursor move.
- **Test:** drag nodes around. Hold X for 2 seconds. Assert positions near T0. Assert cursor unchanged.

### 6f. Z-time-travel
- `interact/time-travel.js` — hold Z → cursor steps backward through history. Tap Z = one step. Alt+arrows = step by one.
- **Test:** append 20 actions. Hold Z for 1 second. Assert cursor moved backward. Release, drag a node. Assert branch created.

### 6g. Keyboard dispatch
- `interact/keyboard.js` — central dispatcher. Enforces priority: only one position-mutating mode per frame. Routes by pointer depth for fractal interaction.
- **Test:** hold Space (gather) and press T (trace) simultaneously. Assert gather active (priority), trace queued.

**Phase 6 acceptance:** reproduce every control from [docs/controls.md](docs/controls.md) in the running app. Confirm each writes to history. Confirm Z-undo of each.

---

## Phase 6.5 — Integration (wiring the engine)

**Goal:** main.js boots a working app. Load history, derive, place, render, interact — the full pipeline from static file to interactive graph. This is NOT new module work; it is connecting Phases 1–6 into a running whole.

**Why this phase exists:** Phases 1–6 built excellent isolated modules with full test coverage, but main.js is still a Phase 1 skeleton. The visual test harness proves the modules compose, but the actual app does not boot. This phase closes that gap before any new feature work.

### 6.5a. Boot pipeline in main.js
- `main.js` loads `runtime/history.csv` (or a bundled static file), replays into state via `data/history.js`.
- Derives clusters via `data/derive.js`. Runs `initialPlace()` or `warmRestart()`.
- Creates SVG via `render/svg.js`. Wires `renderPositions()` as the scheduler's render callback.
- Wires bus events: `row-appended` → derive + re-render, `context-changed` → re-derive.
- **Test:** open `index.html` with a test history.csv. Graph appears. Zoom works.

### 6.5b. Wire DOM events to interact modules
- Click → `select.js`. Mousedown+move → `drag.js`. Keydown/up → `keyboard.js` dispatch.
- Each interaction's output (history rows, position changes) flows through bus → history → state → re-render.
- **Test:** click a node in browser → selection ring appears. Drag → node moves, sticky. Press T → trace wavefront visible.

### 6.5c. Wire fractal render plan to DOM renderers
- On zoom change: `computeRenderPlan()` → feed plan.nodes to `renderNodes()`, plan.edges to `renderEdges()`, plan.hulls to hull renderer, plan.clusterLabels to `renderClusterLabels()`.
- LOD transitions animate: collapsed → expanded shows hull appearing, members fading in.
- **Test:** zoom into a cluster → it expands, hull + member nodes visible. Zoom out → collapses back to dot.

### 6.5d. Codemap parser
- `data/codemap.js` — parse `runtime/depgraph.md` into cluster definitions + importance scores. Emit `memberOf` edges.
- This is needed before the app can load a real codebase.
- **Test:** parse test codemap string → correct clusters, member edges, importance values.

### 6.5e. Pin-expanded (bidirectional pinning)
- SPEC §5 says pinning is bidirectional: pin-collapsed AND pin-expanded. Currently only pin-collapsed works.
- Add `pinnedExpanded` to WorkingContext. Update `lodLevel()` to respect it. Update `expand-collapse.js`.
- **Test:** pin a cluster expanded. Zoom out. Assert it stays expanded even when screen radius < threshold.

### 6.5f. Drag emits spatial edges
- SPEC §10 says drag should write `EDGE add layer=spatial` rows capturing distance to K nearest neighbors (plan2 Option B).
- `endDrag()` computes distances to adaptive K neighbors, emits DISTANCE/spatial edge rows alongside the NODE update.
- These become spring rest-lengths in future physics passes, enabling position recovery from CSV alone.
- **Test:** drag node A. Assert spatial EDGE rows in history with correct distances to neighbors.

**Phase 6.5 acceptance:** open `index.html` → see a graph from a real history.csv. Click, drag, zoom, trace all work in the browser. Every interaction writes to history. The app is usable — not polished, but functional.

---

## Phase 7 — Streaming & Server

**Goal:** Both streaming types work independently. The app works with no server at all.

### 7a. Type A — local persistence
- History writes to localStorage on every append. On reload, loads from localStorage.
- **Test:** drag 5 nodes. Reload page. Assert positions restored (from history replay). Z-travel works.

### 7b. Server
- `depgraph-server.mjs` rewrite:
  - Static file serving.
  - `fs.watch` on source + codemap → triggers producers → producers append to `history.csv`.
  - `GET /history-events` — SSE tailing `history.csv`, push each new line.
- **Test:** start server, open browser. Edit source file. Assert new nodes appear within 2 seconds.

### 7c. Type B — live updates
- `stream/sse.js` — client subscribes to `/history-events`. Each row goes through the same `history.append()` path as a user action.
- **Test:** open two browser tabs. Drag in tab A. Tab B sees the same graph change (via shared history.csv → SSE).

### 7d. Offline-first
- **Test:** disconnect server (or never start it). Open `index.html` with a static `history.csv` bundled. Assert all interactions work. Assert time travel works. Assert history appends to localStorage.

### 7e. Cinematic mode
- `stream/cinematic.js` — when live rows arrive, zoom-tour to each new visible node with highlight.
- **Test:** enable cinematic, trigger producer. Assert camera pans to each new node.

**Phase 7 acceptance:** Three scenarios pass: (1) no server + static file, (2) server + live updates, (3) server dies mid-session → app continues offline.

---

## Phase 8 — Context UI & Weight Tuning

**Goal:** The user can see and change `W`. Context presets work. Weight changes cascade visually.

### 8a. Weight sliders
- Per-layer triple slider: affinity weight / physics weight / opacity.
- Changing any slider emits `context-changed` → `derive.recompute()` → re-render.
- **Test:** slide `calls` affinity weight from 0.3 to 5.0. Assert cluster boundaries shift visibly.

### 8b. Context presets
- Dropdown: `code-review`, `refactor`, `debug`, `trace-state`, `custom`.
- Save current `W` + pins as a named preset.
- **Test:** switch between presets. Assert graph rearranges each time. Save a custom preset, reload, assert it persists.

### 8c. Cluster pin toggles
- Click a cluster in the legend → toggle pin-collapsed / pin-expanded / auto.
- Pins are part of context, not the cluster.
- **Test:** pin "Layout Engine" collapsed. Zoom in until it fills viewport. Assert it stays a dot.

### 8d. Focal set
- Click+Shift on a node → add to focal set. Focal nodes get a visual emphasis (brighter, larger, always-labeled).
- **Test:** add 3 nodes to focal set. Zoom out to overview. Assert all 3 still have visible labels.

**Phase 8 acceptance:** non-technical tester can switch between "code review" and "refactor" presets, see different cluster arrangements, and pin/unpin clusters to tailor the view.

---

## Phase 9 — Scaling

**Goal:** 10k nodes at 60fps. Dirty propagation keeps derivation incremental.

### 9a. Viewport culling integration
- `render/viewport.js` wired to actual render pipeline. DOM elements created/destroyed as viewport moves.
- **Test:** 10k nodes. Pan across graph. Assert DOM element count stays under 1000. Assert 60fps (performance.measure).

### 9b. LOD physics
- Off-screen nodes frozen (gradient zeroed). Adjacent-to-visible nodes tick at 1/4 rate. Collapsed clusters = point-mass.
- **Test:** 10k nodes. Assert `gradient.js` computes < 2000 gradients per frame when zoomed in on one cluster.

### 9c. Dirty derivation
- Add one edge → only 2 nodes' affinities recompute, not 10k.
- **Test:** instrument `derive.js` with a counter. Add one edge to 10k-node graph. Assert recompute count < 50.

### 9d. Snapshot + tail
- On first load of a 50k-row history: snapshot at load, subsequent loads use snapshot + tail.
- **Test:** load 50k rows. Save snapshot. Reload with snapshot + 100 new rows. Assert load < 500ms.

**Phase 9 acceptance:** open a 10k-node history.csv. 60fps throughout. Drag, gather, trace all responsive.

---

## Phase 10 — Producers

**Goal:** Codegen tools append to the unified history.csv. Schema is frozen.

### 10a. History schema freeze
- Document the final CSV schema in `docs/history-schema.md`. Lock columns.
- **Test:** schema validation in `data/csv.js` rejects malformed rows.

### 10b. AST producer
- `codegen/ast.mjs` → reads source, emits NODE + EDGE rows to history.csv.
- **Test:** run against `prototypes/index.html`. Assert output has correct node count (~155 functions).

### 10c. Codemap producer
- `codegen/codemap.py` → reads codemap, emits `memberOf` EDGE rows.
- **Test:** run against `runtime/depgraph.md`. Assert cluster edges match codemap sections.

### 10d. Combined producer
- `codegen/graphgen.mjs` → orchestrates ast + codemap. Appends to history.csv.
- **Test:** run from clean. Load history in app. Assert graph matches current prototype.

### 10e. Historygen
- `codegen/historygen.mjs` → takes current state, emits a replayable history.
- **Test:** generate from snapshot. Replay. Assert identical graph.

**Phase 10 acceptance:** `npm run generate` writes a valid history.csv. The app loads it and shows the current codebase correctly.

---

## Phase 11 — Rules Engine

**Goal:** 5 code-refactoring rules. Suggestion panel. Manual confirm. Transaction-based history.

### 11a. Pattern matcher
- `rules/matcher.js` — subgraph isomorphism against derived state. Returns list of match sites.
- **Test:** define "extract function" pattern (3+ shared callers). Assert it finds 2 match sites in the test graph.

### 11b. Rule library
- `rules/library.js` — 5 rules: `extract-function`, `inline-function`, `rename`, `merge-clusters`, `split-cluster`.
- Each rule: `{name, description, match(graph), apply(binding) → HistoryRow[]}`.
- **Test:** apply `rename` rule. Assert 1 NODE update row + N EDGE update rows (relabeled).

### 11c. Transaction application
- `rules/apply.js` — takes rule + binding → generates history rows with `payload.rule=name` + shared `payload.txId`. Appends to history.
- **Test:** apply a rule, then Z-undo. Assert entire transaction reverted as a unit.

### 11d. Suggestion panel
- `rules/panel.js` — side panel listing available rules + match count. Click to preview (show affected nodes highlighted). Confirm to apply.
- **Test:** open panel. See "extract-function: 2 sites". Click one. Assert affected nodes glow. Click confirm. Assert history rows appended.

### 11e. Branch on multiple bindings
- If a rule has 3 valid bindings, applying creates 3 branches.
- **Test:** apply a rule with 2 bindings. Assert 2 branches created. Navigate between them.

**Phase 11 acceptance:** a user can see "rename: 5 sites" in the panel, click one, preview the effect, confirm, and undo with Z.

---

## Phase 12 — Agent Endpoints

**Goal:** An AI agent can read the graph, propose a context, write rows, and see effects.

### 12a. Read endpoint
- `GET /agent/read?depth=2` → JSON: `{nodes, edges, clusters, context, cursor}`. Depth limits recursive expansion.
- **Test:** `curl /agent/read?depth=1` → valid JSON, < 100KB for a 1k-node graph.

### 12b. Append endpoint
- `POST /agent/append` → body = `[{type, op, id, ...}, ...]`. Server validates schema, attributes `payload.author`, appends to history.
- **Test:** POST 3 rows. Assert they appear in `/history-events` SSE. Assert they show up in the app with "agent" attribution badge.

### 12c. Explain endpoint
- `GET /agent/explain?node=buildGraph` → NL description assembled from local 2-hop neighborhood, cluster membership, affinity distribution.
- **Test:** assert response is a non-empty string containing the node's cluster name and top 3 neighbors.

### 12d. Subscribe endpoint
- `GET /agent/subscribe?author=human` → SSE, filters history rows by author. Agents watch for user actions to react to.
- **Test:** user drags in browser. Agent subscription receives the drag row within 1 second.

### 12e. Rules endpoint
- `GET /agent/rules` → list of available rules with their match counts.
- Agent can POST to `/agent/append` with rule-application transactions.
- **Test:** agent reads rules, picks one, applies it. Assert transaction in history.

**Phase 12 acceptance:** a script (or LLM via function-calling) can: (1) `GET /agent/read` to understand the graph, (2) `POST /agent/append` to propose a new context, (3) see the visual result change in the browser.

---

## Phase 13 — Polish & Ship

### 13a. Performance budget
- Assert 60fps at 10k nodes on M1 MacBook in Chrome.
- Assert initial load < 2s for 10k-row history.
- Profile and fix any regression from phases 9–12.

### 13b. Offline resilience
- localStorage mirror of history is always valid. Page reload never loses work.
- Server crash mid-stream does not corrupt client state.

### 13c. Documentation
- `docs/history-schema.md` — frozen CSV schema.
- `docs/controls.md` — updated with any new controls.
- `docs/agent-api.md` — endpoint reference for AI consumers.
- `README.md` — updated with new architecture, screenshots, quick start.

### 13d. Delete the old code
- Remove `prototypes/index.html` (the 7600-line monolith).
- Remove old `codegen/codemap.py` Python-regex approach if replaced by AST producer.
- Remove `nodes.csv`, `edges.csv`, `user-actions.csv` from runtime/ (superseded by history.csv).
- Clean up `todo.md`.

---

## Dependency Graph (phases)

```
Phase 0 (scaffold)              ✅ DONE
  └─► Phase 1 (core runtime)    ✅ DONE
       └─► Phase 2 (history)    ✅ DONE
            └─► Phase 3 (derivation)  ✅ DONE
                 ├─► Phase 4 (placement)   ✅ DONE
                 │    └─► Phase 5 (rendering)   ✅ DONE
                 │         └─► Phase 6 (interaction)   ✅ DONE
                 │              └─► Phase 6.5 (integration) ◄── YOU ARE HERE
                 │                   ├─► Phase 7 (streaming/server)
                 │                   ├─► Phase 8 (context UI)
                 │                   └─► Phase 10 (producers)
                 │
                 └─► Phase 9 (scaling) ◄── can start after Phase 6.5
                      └─► Phase 11 (rules) ◄── needs Phase 6.5 + 9
                           └─► Phase 12 (agent) ◄── needs Phase 7 + 11
                                └─► Phase 13 (polish)
```

**Phase 6.5 is the gate.** It produces the first bootable app. Phases 7, 8, 9, 10 can run in **parallel** after Phase 6.5 ships. Phase 11 needs Phase 9 (for large-graph matching perf) and Phase 6.5 (for browser-based testing). Phase 12 needs Phase 7 (server) and Phase 11 (rules).

---

## Critical Path

```
0 → 1 → 2 → 3 → 4 → 5 → 6 → 6.5 → 9 → 11 → 12 → 13
```

Everything else (7, 8, 10) is off the critical path and can be parallelized by a second contributor.
