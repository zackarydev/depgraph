# Depgraph — Product Spec (Rebuild Edition)

> This document is the **blueprint to recreate depgraph from scratch with a better structure**. It describes *what* the product is, *how* it is built, and the *architecture* it must have. It is not a history of the current code — it is the target.
>
> **The old prototype has been deleted from this directory.** A frozen copy lives at `../depgraph-v0/` for archaeological reference only. Do not read it before building — the point of this rebuild is to avoid inheriting its biases. If you need to understand a past decision, the reviews document the lessons without the coupling: [docs/reviews/REVIEW_2.md](docs/reviews/REVIEW_2.md).
>
> Companion docs: [VISION.md](VISION.md), [README.md](README.md), [docs/controls.md](docs/controls.md), [docs/codegen.md](docs/codegen.md), [docs/reviews/REVIEW_2.md](docs/reviews/REVIEW_2.md) (lessons learned).

---

## 1. Product Goal

Depgraph is a **spatial programming environment**: an interactive hypergraph viewport into a codebase (or any relational dataset) where nodes, clusters, and edges are first-class and manipulable. The user explores structure by dragging, gathering, tracing, and rewinding — not by reading files top-to-bottom.

The long-term claim (see [VISION.md](VISION.md)): *the graph IS the UI IS the data.* A cluster is a hyperedge that is also a node; zoom is traversal, not scaling; position is meaning.

### What a user does with it
1. Loads a project (source files + a human/AI-written codemap).
2. Sees functions as nodes, systems as cluster hulls, dependencies as typed edges.
3. Navigates by **gathering** related nodes, **tracing** call chains, **rewinding** to prior arrangements, and **zooming** into structural detail.
4. Annotates space by dragging: the arrangement itself becomes data (spatial affinity).
5. Watches the graph update in real time as source files, runtime traces, or external event streams change.

### Non-goals
- A static code-diagram generator. Depgraph is interactive and live.
- A file-tree browser. Hierarchy emerges from edges + codemap, not folders.
- A general-purpose D3 playground. Every visual must encode relational meaning.

---

## 2. Scope — v1 is the seed, the architecture is the tree

[VISION.md](VISION.md) describes the long-term target: an infinite, continuously-updating relational fabric with scale-invariant zoom, observer-dependent rendering, multiway evolution, and rule-rewriting over the hypergraph itself. That is the **tree**.

**v1 is the seed**: one concrete application of the tree — *code exploration*. A function is an ontological node. A dependency is a spacetime edge. A module is a cluster. The user explores one codebase at a time, in 2D, with 1k–10k nodes, locally on their machine.

Every decision in this spec is constrained by the rule: **v1 must ship as a useful code tool, and nothing v1 does may foreclose the tree.**

### What v1 ships
| Capability | v1 | Horizon |
|---|---|---|
| Graph size | 1k–10k nodes, 10k–100k edges, one project | Unbounded, continuously updating, cross-project |
| Rendering | 2D SVG / D3 | 2D + 3D manifold; pluggable projector |
| Data source | source code via AST + codemap | any relational stream (runtime traces, sensors, knowledge bases, physics simulations) |
| Graph evolution | file changes, user actions | rule rewrites applied to the hypergraph itself (§13) |
| History | linear cursor + branches | full multiway system |
| Observer | one WorkingContext at a time | multiple simultaneous reference frames, observer-dependent projections |
| Agency | human drags, AI suggests weights | AI-authored contexts, AI-applied rewrite rules, AI-explained structure |
| Runtime | browser SPA + Node server | distributed, shardable by subgraph |

### Architectural commitments (non-negotiable, even in v1)
These are the load-bearing decisions that keep the horizon reachable:

1. **Two primitives only.** Node + Edge. Every higher structure is derived. (§3) — so any domain, not just code, fits.
2. **Unified event log.** Everything is a row in `history.csv`. (§4) — so any evolution model (linear, branching, multiway) is just cursor semantics.
3. **Weights are context, not constants.** (§3) — so one engine serves code, biology, physics; only `W` changes.
4. **Gradient descent, one energy.** (§8) — so forces, pins, rules, and observers all compose as terms in `E`.
5. **Recursion by construction.** Clusters are nodes. (§3, §5) — so hierarchy has no ceiling.
6. **Pluggable projection.** 2D today, 3D-ready. (§8) — so the visual axis is not baked in.
7. **Observer-dependent rendering.** `WorkingContext` IS the reference frame. (§3) — so the vision's "observer" is already scaffolded.
8. **Streaming by default.** The app is a reducer over an event stream. (§4, §11) — so real-time and replay are the same path.

---

## 3. Core Data Model

There are **only two primitives**: `Node` and `Edge`. Everything else — hyperedges, clusters, affinities — is a **computed derivative** of the edge set. The data model is a differential hierarchy, and because clusters are also nodes, the hierarchy is **recursive**: the output of one derivative becomes input to the next.

### Primitives

| Type | Description | Key fields |
|---|---|---|
| **Node** | Any atom: function, global, parameter, value, user annotation, *or a cluster-as-node* | `id, kind, label, importance, minZoom` |
| **Edge** | Typed, directed-or-undirected relation between two nodes | `source, target, layer, weight, directed` |

That's it. A node has no `cluster` field. A node has no `affinities` field. Those are not stored — they are queries over the edge set.

### Derivatives (computed, never stored as primary state)

| Order | Derived thing | Definition | Depends on |
|---|---|---|---|
| **d⁰** | Node, Edge | primitives | — |
| **d¹** | **HyperEdge** | an equivalence class of edges that share a common member (e.g., "all edges of layer=`reads` touching global `currentNodes`") | edges |
| **d¹** | **Affinities** | per-node distribution `Map<groupId, weight>` computed from the edges incident on that node, weighted by layer | edges |
| **d²** | **Cluster** | a hyperedge promoted to a node — the set of nodes that share membership in a hyperedge becomes itself a node with its own edges (meta-edges) | hyperedges |
| **d³⁺** | **Super-cluster** | a cluster whose members are clusters. Recursion continues until a fixed point (no further grouping reduces edge count). | clusters |

**The recursion:** `d²` promotes a `d¹` hyperedge into a node. That new node participates in the edge set, which regenerates `d¹` at the next level. Fixed-point iteration builds the hierarchy. The same engine runs at every depth.

**Invariant:** a cluster is a node. Its "members" are not a special field — they are the set of nodes connected to it by an edge of layer `memberOf`. Expanding a cluster means rendering those members as siblings; collapsing means hiding them and rendering the cluster-node instead.

### Affinities (worked example)
Given a node `n` and its incident edges `E(n)`, affinities are:

```
affinity(n, g) = Σ { edge.weight × layerWeight(edge.layer) : edge ∈ E(n), groupOf(edge.other) = g }
normalize so Σ_g affinity(n, g) = 1
```

Default layer weights (a starting point, not a law):
1. `memberOf` (codemap) — 5.0
2. `sharedName` (token match) — 1.5
3. `shared` / `sharedWrites` (globals) — 0.5
4. `calls` / `calledBy` — 0.3 / 0.2

Affinities are **re-computed** whenever the edge set changes **or the weights change**. There is no stale affinity to invalidate. The **primary cluster** is `argmax(affinity(n, ·))`.

### Layer weights are themselves dynamic — the 2nd derivative of weights

Layer weights are **not constants**. They are a **vector that the user (or AI) steers** based on the current task. The same hypergraph is a different graph depending on what you are trying to do:

| Working context | What dominates | Demoted |
|---|---|---|
| *"How does this codebase work?"* | `calls`, `calledBy`, `memberOf` | `sharedName` |
| *"Who touches global state X?"* | `shared`, `writesTo`, `reads` | `calls` |
| *"Refactor this module"* | `memberOf`, spatial affinity | `sharedName` |
| *"How does a bird's biology allow flight?"* (different dataset) | `anatomical-adjacency`, `functional-coupling` | `taxonomic` |

So the weights vector `W = [w_calls, w_shared, w_memberOf, …]` is itself a function of context:
```
W = f(context)
affinities = f(edges, W) = f(edges, f(context))
```

That makes `W` a **2nd-order derivative** — a derivative *of* the derivative that produces affinities. The UI must expose weight control at roughly this granularity:

- **Per-layer opacity slider** (visual only) — already exists, keep it.
- **Per-layer physics weight** (how strongly this layer attracts) — separate from opacity.
- **Per-layer affinity weight** (how much this layer contributes to clustering) — separate again.
- **Context presets** — named snapshots of the full weight vector (`"code-review"`, `"refactor"`, `"debug"`, `"trace-state"`).
- **AI-driven weight suggestion** — given a user's stated task, an agent proposes a weight vector.

Weight changes **cascade**: change `W` → affinities recompute → primary clusters shift → hulls redraw → physics retargets. This cascade must be cheap (incremental, not full rebuild) because the user will tune weights continuously.

### Why this matters
- **One engine, all depths.** The code that groups functions into modules is the same code that groups modules into services.
- **No drift.** Today's bugs came from storing cluster IDs on nodes and having them diverge from edges. Derivatives cannot drift from their source.
- **Fractal by construction.** See §5.
- **Context is a first-class input.** The derivatives depend on `W`; `W` depends on context. Changing context is the primary creative act the tool supports.

### Working Context

The **Working Context** is the shared state that controls weights, pinned nodes, focal interests, and the active preset. It is a single object:

```
WorkingContext = {
  name,                  // e.g. "refactor-auth"
  weights: W,            // affinity + physics + opacity weight vectors
  pinnedNodes: Set,      // nodes the user is keeping in spatial focus
  pinnedClusters: Set,   // clusters forced to stay collapsed (see §5)
  focalNodes: Set,       // nodes the user is "looking at" now
  lensEdgeLayers: Set,   // which layers are currently relevant
  goal: string,          // human/AI description of what the user wants
}
```

Contexts are **named, saveable, shareable**, and persist alongside arrangements. Switching context is like switching lenses on the same hypergraph: nothing about the underlying edges changes, but everything visible does. Contexts can be authored by the user, proposed by an AI agent, or inferred from recent interactions.

---

## 4. External Data Contract

Depgraph is **data-source-agnostic**. The browser never parses source code. All ingestion produces append-only rows consumed via one streaming interface.

### The unified history file

There is **exactly one authoritative runtime file**: `runtime/history.csv`. It is an append-only event log. **Every fact about the graph, and every user action, is a row in history.csv.** There are no secondary truth files; `nodes.csv` and `edges.csv` may exist as derived caches but can always be rebuilt by replaying history.

The history encodes **only the two primitives from §3**: Node creation/update and Edge creation/update. Everything else (clusters, hyperedges, affinities, user actions) is derived or is itself encoded as nodes/edges in the same file.

**Schema (single table, header present):**
```
t,type,op,id,kind,source,target,layer,weight,label,payload
```

| Field | Meaning |
|---|---|
| `t` | monotonic timestamp (event order; replay cursor) |
| `type` | `NODE` or `EDGE` (the two primitives, nothing else) |
| `op` | `add` / `update` / `remove` |
| `id` | node id, or edge id = `source→target@layer` |
| `kind` | node kind (`function`, `global`, `cluster`, `user-action`, …) or edge nature |
| `source,target` | edge endpoints (ignored for NODE rows) |
| `layer` | edge layer for EDGE rows |
| `weight` | numeric weight |
| `label` | display label |
| `payload` | JSON blob for producer-specific extras (line number, context snapshot, etc.) |

### User actions are rows in the same file

A drag, a click, a lock, a context switch — **each writes a row to history.csv**. Examples:
- Drag finished → one `NODE update` row with the new position in payload.
- Shift+click pin → one `EDGE add layer=pinned` row.
- Spatial proximity from drag → one `EDGE add layer=spatial weight=…` row.
- Context switch → one `NODE add kind=context-event` row.

Because user actions are edges and nodes, **they are graph data**. The graph describes its own editing history using its own primitives. This is the point of the unified file.

### Two independent streaming concerns

Streaming has **two separate meanings**, and depgraph must not conflate them:

**1. History persistence (always on).** Every event the app produces — user or system — appends to `runtime/history.csv`. This is **local event sourcing**. It works entirely offline, with no server, as long as the app can write a file (or localStorage mirror). Without this, time travel does not work.

**2. Code live updates (optional).** External producers (AST scanners, runtime tracers) watch source files and **append NODE/EDGE rows to the same history.csv**. The server pushes those new rows to the client via SSE. If this is disabled, the app still works: it loads whatever history exists and is fully interactive.

```
       ┌──── code producers (ast.mjs, tracer) ────┐   (OPTIONAL)
       │                                           │
       ▼                                           │
   history.csv  ◄──────────── user actions ────────┤   (ALWAYS ON)
       │                                           │
       ▼                                           │
   SSE replay (server)  ───────────► client  ──────┘
```

**Everything works without either form of streaming.** Open a static `history.csv`, load it once, and the app is fully interactive: drag, gather, trace, time-travel all function. Live code updates are a *feature*, not a requirement.

### Other files
- `runtime/depgraph.md` — the codemap: `## Cluster` headings, `` - `name`: ~line importance:N `` entries, YAML frontmatter. This is input to producers, not a runtime source.
- `runtime/context.json` — saved Working Contexts (§3). Optional; has localStorage fallback.

`nodes.csv` and `edges.csv` if present are **derived caches** written by producers. They are never sources of truth — the history is.

### Producers (pluggable, each appends to history.csv)
- `codegen/codemap.py` — regex scan of source
- `codegen/ast.mjs` — Acorn AST walk (calls, reads, writes, rw edges)
- `codegen/graphgen.mjs` — combines AST + codemap
- `codegen/historygen.mjs` — replay-pack: takes a snapshot and emits a playable history
- `codegen/simulator.mjs` — synthetic events for demos
- *(future)* runtime tracer, git-history producer, LLM semantic tagger

### Transport
A Node.js server (`depgraph-server.mjs`) does three things:
1. Static file serving (the SPA).
2. `fs.watch` on source files & codemap → triggers producers → producers append to `history.csv`.
3. SSE endpoints streaming new history rows to clients:
   - `/history-events` — tails `history.csv`, pushes each appended row
   - `/focus-events` — step-debugging focus overlay (sugar)

A separate `stream/streamer.mjs` process owns replay with pluggable sources (`stream/sources/*.mjs`): file, follow-mode, loop-mode, tick-grouped or line-grouped.

---

## 5. Fractal Rendering & Recursion

Because clusters are nodes, the hierarchy is **self-similar at every depth**. The rendering engine exploits this: one render routine draws the graph, and it calls itself to draw the interior of any expanded cluster.

### The recursion
```
renderGraph(nodes, edges, depth):
  for each node n in nodes:
    if n is a cluster and n.expanded and visibleRadius(n) > threshold:
      renderGraph(members(n), edgesWithin(n), depth + 1)   // recurse
    else:
      drawNode(n)                                           // leaf
  drawEdges(edges)                                          // incl. meta-edges at this depth
```

Every depth uses the **same layer stack** (hulls → meta-links → links → nodes → labels → cluster-labels), the **same physics**, the **same interaction modes**. Depgraph is a fractal: zoom deeper, see the same shapes with different labels.

### Level-of-detail (LOD) by screen radius, not by absolute zoom
A cluster expands when its on-screen radius crosses a threshold (e.g., 80px). This is zoom-agnostic: a small cluster you zoomed into expands at the same screen size as a giant cluster you zoomed out of. Navigation becomes **fractal descent** — the user walks down the tree by crossing screen-radius thresholds, not by hitting magic zoom numbers.

| Screen radius | What the cluster-node shows |
|---|---|
| < 8px | dot (pure node) |
| 8–40px | circle + label |
| 40–80px | circle + label + meta-edges to siblings |
| 80–200px | **expands**: hull appears, members render inside, recurse |
| > 200px | fully expanded; its own meta-edges visible; children may themselves expand |

### Cluster pinning — screen radius is a default, not a mandate
Some clusters are **irrelevant to the current task** no matter how big they grow on screen. The rendering engine honors `WorkingContext.pinnedClusters`: any cluster in that set **stays as a single node regardless of its screen radius**. Its hull is never rendered; its members never unload. A giant library module during a domain-logic review should stay a pebble even when it fills the viewport.

Pinning is bidirectional:
- **Pin collapsed** (keep as a node) — cluster never expands, members invisible
- **Pin expanded** (keep open) — cluster never collapses even when it shrinks on screen, e.g., a small-but-critical module you are actively editing

Both forms are properties of the context, not the cluster. The cluster itself has no state about expansion — the context decides.

### Meta-edges are projections of the same edges
At depth *d*, an edge between two clusters is a **meta-edge** — it is the aggregate of all primitive edges whose endpoints live inside those two clusters. When you descend into one cluster, that meta-edge resolves into its constituent edges. No separate data structure: meta-edges are a `group-by` query.

### Physics is hierarchical
Each expanded cluster runs its own local force simulation over its members, with boundary-constrained collision against its hull. Parent-level physics treats each expanded cluster as a **soft body** whose shape is its hull, not a rigid circle. Collapsed clusters behave as point-masses. The scheduler ticks outer levels less often than the currently-focused level (LOD on compute, too).

### Fractal interaction
Every interaction operates at the **depth the user is pointing at**. Gather at depth 0 pulls clusters together; gather at depth 2 pulls functions within a module. The keyboard dispatcher reads pointer depth and routes to the local engine. There is no special code for "inner-cluster gather" vs "outer-cluster gather" — it is the same function called at a different depth.

### Rendering budget
Recursion is bounded by a render budget: if total visible primitives exceed N (say 5000), the engine refuses to expand deeper clusters and shows them as leaves. The user then explicitly enters a cluster (click-to-descend) to unload sibling depth. Similar to MIP-mapping: you only pay for what you see.

### Why this replaces `minZoom`
Today, structural nodes (parameters, values) carry `minZoom: 10` and fade in at a hardcoded zoom level. Fractal rendering makes this implicit: a function node at depth *d* expands into its parameters at depth *d+1* when its on-screen radius crosses the threshold. No per-node zoom hardcoding.

---

## 6. Module Architecture (the rebuild)

One HTML file that imports ES modules. Global state lives in **one object**; every module receives it explicitly. No more 40+ top-level `let` bindings.

```
src/
  core/
    types.js          Node, Edge (the two primitives); Derivatives typedefs
    state.js          single State object; all mutations go through reducers
    animation.js      ONE requestAnimationFrame scheduler; modules register tick fns
    bus.js            typed event bus (select, cursor-moved, context-changed, …)
    context.js        WorkingContext: weights W, pins, focal, goal; named presets
  data/
    csv.js            RFC4180 parser, streaming reader/appender
    history.js        the unified history log; cursor, replay, branches, append
    snapshot.js       snapshot writing / loading (§13 scaling); segments addressing
    codemap.js        parse runtime/depgraph.md into producer input
    derive.js         compute hyperedges / affinities / clusters from edges
                      re-derives on W or edge change; dirty-propagation (§13)
    graph-builder.js  history rows → live {nodes, edges} maps
  layout/
    positions.js      UNIFIED PositionState: {x,y,sticky,locked,t0} per node
    manifold.js       high-dim embedding → 2D projection; pluggable projector interface
    gradient.js       energy function + gradient descent step (§8)
    quadtree.js       Barnes-Hut spatial index (2D); octree-ready interface (§13)
    placement.js      initial layout, streaming placement via manifold-interpolation
    warm-restart.js   sticky-preserving re-settle on rebuild
  edges/
    layers.js         EDGE_LAYERS registry, pullLayerState, sliders UI
    visibility.js     ONE isVisible(node/edge, context, cursor) query
    opacity.js        edgeOpacity(edge, ctx) — single source of truth
  render/
    svg.js            init, 6 layer groups, d3 zoom (0.1–12×)
    viewport.js       spatial-index query for visible set + halo; cull everything else (§13)
    nodes.js          circle + affinity rings + event wiring
    edges.js          lines, gradients, arrowheads
    hulls.js          d3.polygonHull + expandHull + textPath boundary labels
    meta-edges.js     inter-cluster beziers; also owns clusterCentroid() (UNIFIED)
    labels.js         node labels + floating cluster labels + placement solver
    positions.js      renderPositions() — called ONCE per frame by the scheduler
  navigation/
    semantic-zoom.js  maps zoom k → screen-radius LOD; emits state, never touches DOM
    expand-collapse.js cluster topology changes (independent of zoom); respects context pins
  interact/
    select.js         single selectedNode + selectedNodes Set, one code path
    drag.js           node drag, group drag, cluster-label drag → history append
    attractor.js      force-press / shift-hold pull
    reset.js          X-key: positions → T0, weights → context defaults (NOT time travel)
    time-travel.js    Z-key: moves the history cursor; supports branches
    trace.js          T-BFS (forward/backward/both, flash, hold)
    gather.js         neighbor / cluster / intra-cluster / space-pull (one engine)
    keyboard.js       central dispatch; routes by pointer-depth for fractal interaction
  rules/
    matcher.js        subgraph pattern matching (small graph isomorphism)
    library.js        built-in code rules: extract-fn, inline-fn, rename, merge/split cluster
    apply.js          rule application → transaction of history rows (§15)
    panel.js          suggestion side panel (v1: manual confirm only)
  agent/
    read.js           /agent/read endpoint handler (derived state → JSON, sized-by-depth)
    append.js         /agent/append — validate + attribute + insert history rows
    explain.js        /agent/explain — assemble NL description from local graph walk
    subscribe.js      /agent/subscribe — SSE proxy to /history-events with filtering
  stream/
    sse.js            /history-events client; applies incoming rows
    cinematic.js      zoom-tour over live-producer rows (optional visual mode)
  main.js             bootstrap: load history (snapshot+tail), build context, subscribe to bus
```

### Rules for the rebuild
1. **Single render pump.** All loops register with `core/animation.js`. Exactly one `renderPositions()` per frame.
2. **Single visibility query.** `isVisible(node, context, cursor)` — one function, called from everywhere.
3. **Single position state.** `{x, y, t0, sticky, locked}` per node. Nothing parallel.
4. **Navigation ≠ zoom.** Zoom is camera. Navigation is expand/collapse (topology) + context switch (lens).
5. **Clusters are nodes.** Derived, recursive. Expansion is driven by screen radius + context pins.
6. **Two primitives only.** Node and Edge. Everything else is a derivative. No stored `cluster` field on a node.
7. **Unified history.** `runtime/history.csv` is the single source of truth. User actions and system events share one table.
8. **Gradient descent, one energy.** Every force is a term in `E`. Interactions add/remove terms.
9. **Context is input.** Layer weights `W` come from context, not from constants. `W` change cascades.
10. **Time travel = cursor move.** X resets, Z moves cursor. Never confuse them.
11. **No physics when idle.** `‖∇E‖ < ε` → stop ticking.
12. **Event bus over globals.** Selection, cursor, context, rebuild all flow through `core/bus.js`.

---

## 7. Pipelines

### Ingest pipeline (server-side)
```
source files ──► producer (codemap.py | ast.mjs | tracer) ──► nodes.csv, edges.csv
codemap.md ────┘                                                      │
                                                                      ▼
                                                     watcher → SSE /graph-events
```

### Client pipeline (browser)
```
SSE/fetch ─► csv.js ─► ingest.js ─► cluster.js ─► graph-builder.js
                                         │
                                         ▼
                              layout/placement.js (initial)
                                         │
                                         ▼
                        physics.js (streaming) / positions.js (sticky reuse)
                                         │
                                         ▼
                                   render/* (D3 joins)
                                         │
                                         ▼
                               animation.js renderPositions
```

### Rebuild pipeline (live reload)
- Sticky/locked positions preserved across rebuilds.
- Only new nodes get fresh placement (see §8 Placement).
- Warm restart runs short gradient-descent pass (≤ 60 iterations) for micro-settle.
- Rebuild is scheduled, not immediate: debounced while the user is interacting.

---

## 8. Placement as Gradient Descent on a Manifold

Force-directed layout is one special case of a more general idea: **each node lives on a high-dimensional surface defined by the edge set and the weight vector, and its 2D position is a projection of that surface.** The visible graph is the shadow the manifold casts on the screen.

### The manifold

Conceptually, each node `n` has a latent position `Ψ(n) ∈ ℝᴰ` in a high-dimensional space where:
- Each edge layer contributes one or more dimensions (or axes).
- Distance in `ℝᴰ` between two nodes reflects how related they are under the current `W` (working-context weights).
- The manifold warps when `W` changes — changing context literally reshapes the surface.

The screen shows `π(Ψ(n)) ∈ ℝ²`, a 2D projection (e.g., MDS, UMAP-like, or a hand-rolled stress-majorization). We do not need to materialize `Ψ` explicitly — we just need its **gradient** with respect to each node's 2D position.

### Gradient descent replaces "physics"

We define an **energy function** `E(positions) = Σ edge-stresses + Σ repulsion + Σ boundary + Σ user-pins`:

```
E = Σ_edges       w_layer(e) · (‖x_s − x_t‖ − d_target(e))²        // attraction
  + Σ_pairs       repulsion(‖x_i − x_j‖)                            // collision
  + Σ_pinned      k_pin · ‖x − x_pinned‖²                           // user anchors
  + Σ_hulls       hull-boundary penalties                           // containment
  + Σ_ctx         context-specific terms (focal emphasis, lens)     // W-driven
```

Per frame, the layout engine takes one step:
```
x ← x − η · ∇E(x)
```

This replaces ad-hoc force loops with a single differentiable objective. Consequences:
- **Initial layout** = run gradient descent until `‖∇E‖ < ε` or a frame budget expires.
- **Streaming placement** = new node starts at a seed position (centroid of its incident edges' neighbors, or manifold-interpolation), then descends.
- **Warm restart** = descend from current positions with a small step size; sticky nodes have clamped gradient (they don't move but still exert force).
- **Context change** = `W` changes → `E` changes → a few descent steps re-settle the graph.
- **Drag** = user overrides `x` for one node; gradient updates the rest.
- **Gather / attractor / repulse** = add temporary terms to `E`; remove them on release.

### Why this is better than "forces"

1. **One knob: η (step size).** No per-force tuning. Damping is a property of the descent, not each force.
2. **Compositional.** Every interaction is "add a term to E." Removing the interaction removes the term. Clean cleanup.
3. **Deterministic settle.** Settle = `‖∇E‖ < ε`. No 90-frame kinetic-energy heuristic.
4. **Differentiable by construction.** Future: let the weights themselves be learned from spatial memory (user drags gradients into `W`).

### Projection choice

Initial implementation: **stress majorization** (classical MDS-style) using graph-theoretic shortest-path distances as targets, weighted by `W`. Future: pluggable projector interface so UMAP, t-SNE, spectral layout, or learned embeddings can swap in.

### Sticky & locked in this model
- **Sticky node**: gradient is dampened (η_sticky ≪ η), so the descent nudges but barely moves it.
- **Locked node**: gradient zeroed (η_locked = 0); position is a hard constraint.
- **Dragged node**: η = ∞ for this frame (user sets position); all others descend.

### Hierarchical descent (fractal placement)
Each expanded cluster runs a **local** descent over its members with the hull as a boundary constraint. Parent-level descent treats the cluster as a soft body whose shape follows from member positions. Collapsed clusters are point-masses. This is the gradient-descent analogue of the hierarchical physics described in §5.

---

## 9. Rendering Model

### SVG layer stack (bottom → top)
1. `gHulls` — cluster polygons + textPath boundary labels
2. `gMetaLinks` — inter-cluster bezier gradients
3. `gLinks` — individual edges
4. `gNodes` — circles + affinity rings
5. `gLabels` — node text
6. `gClusterLabels` — floating cluster names + user cluster legend

### LOD is screen-radius, not zoom-level
What is visible at any point follows the fractal-descent rules in §5 (screen radius thresholds + context pins). There are no hard-coded zoom breakpoints. Edge-layer opacities come from `WorkingContext.weights` (§3), not zoom presets.

Optical zoom is purely the camera: pan + scale. It changes nothing about content. If the user wants to *navigate*, they descend into a cluster (expand) or ascend (collapse), which is a topology change, not a camera change.

### Edge layers (canonical set)
`calls, calledBy, uses, writesTo, shared, sharedWrites, importance, memberOf`. New layers register dynamically (`ensureEdgeLayer`) when unknown types arrive from streams. Each has `{id, color, dash, directed}` and a per-layer opacity slider.

---

## 10. Interaction Spec (X, Z, and the history cursor)

Canonical controls: see [docs/controls.md](docs/controls.md). Keep that file as the user-facing reference; this section documents the **interaction engine** behind it.

### Interaction modes (mutually constrained)
| Mode | Trigger | Engine | Cleanup |
|---|---|---|---|
| Select | click | `interact/select.js` | Escape or click empty |
| Drag | mousedown+move | `interact/drag.js` | mouseup (writes history row) |
| Attractor | force-press / shift-hold | `interact/attractor.js` | release (auto-locks pulled nodes) |
| Gather | Space (+ modifiers) | `interact/gather.js` | Space-up |
| **X-Reset** | hold X | `interact/reset.js` | X-up |
| **Z-TimeTravel** | hold Z | `interact/time-travel.js` | Z-up (cursor persists at new position) |
| Trace | tap/hold T | `interact/trace.js` | T-up or Escape |

**Priority rule:** only one mode may mutate positions per frame. Trace and semantic-zoom are read-only overlays and may run concurrently.

### X is RESET, not time travel
Hold X to **reset positions and/or weights** toward a target state. X does NOT move the history cursor. It does not navigate the past. It applies a correcting gradient toward a known configuration.

- **Hold X** → positions decay toward T0 (initial layout). Weights decay toward the current context's defaults.
- **Shift+X + click node** → that node's position resets to T0.
- **Ctrl+X** → weights reset to context defaults, positions untouched.
- Release X → decay stops where it is. The user ends up wherever X put them, and a normal drag-stop-style row is written to history.

X is a **restoring force**. It is how the user says "undo my mess" without moving through time. After X, the graph is still at the current history cursor — only the positions changed.

### Z is TIME TRAVEL through the unified history
Hold Z to **move the history cursor backward** through `history.csv`. This is the canonical and *only* time-travel mechanism. It works identically whether history arrived from a live stream, a static file, or purely from user actions in this session.

- **Hold Z** → history cursor steps backward; graph state is whatever was true at that cursor. Positions, edges, nodes, contexts — everything that was a history row — replays in reverse.
- **Tap Z** → one step back.
- **Alt+← / Alt+→** → step cursor by one event.
- **Shift+Z** → fast-reverse (larger stride).
- **Release Z** → cursor stays where it landed. **New user actions append new history rows at this cursor**, which creates a branch (see below).

Because history records *both* system events (NODE/EDGE add from AST) and user events (drags, pins, context switches), Z unwinds both. You can Z back past a live-reload event to see the graph before that file change; you can Z back past a drag to see where the node was before you moved it. Same mechanism.

**Branching on new action after Z**: the previous tail-of-history becomes an alternate branch. Branches are stored as a sibling event chain in history.csv with a `branch` tag in `payload`. Alt+↑ navigates branches. This is how "I want to try a different arrangement" works.

**Time travel works without streaming.** Streaming adds rows; it does not own the cursor. A user who never enables live updates still gets full Z-travel over their own drag/pin/context history.

### Spatial memory = user actions in history
- Drag proximity → `EDGE add layer=spatial weight=…` row.
- Click co-occurrence → `EDGE add layer=co-click` row.
- Lock/pin → `EDGE add layer=pinned`.
- Decay is implemented as periodic `EDGE update weight=…×decay` rows written by a background task.
- No separate `user-actions.csv`, no separate spatial-memory store. It is all in `history.csv`.

---

## 11. Streaming: Two Independent Concerns

Streaming is two independent systems that happen to share the same file format. Both can run, either can run, neither has to run.

### Type A — History persistence (always on, local)
The client writes every user action to `history.csv` (or a localStorage mirror if no server). This is event-sourcing. The app is a state machine whose transitions are history rows; the cursor's position defines the current state. Consequences:

- **Offline-first.** No server required.
- **Time travel always works.** Z-key replays rows the user themselves produced.
- **Reproducible.** Hand someone your `history.csv` and they see exactly what you saw.

### Type B — Code live updates (optional, server-pushed)
External producers (AST walker, runtime tracer, git watcher) append NODE/EDGE rows to `history.csv`. The server tails the file and pushes new rows to every connected client via SSE. Consequences:

- **The app reacts to source changes without reloading.**
- **Live updates and user actions share one stream.** The client cannot tell them apart except by `kind` — which is correct, because they *are* the same thing (graph-mutation events).
- **Without this, the app still works.** It loads whatever history exists and remains fully interactive.

### Ingestion phases (for any row source)
Whether rows come from disk, SSE, or the user's own drag, the client processes them through one pipeline:

1. **Apply** — update the derived node/edge maps.
2. **Place** — for new nodes: seed position via manifold-interpolation from neighbors (§8).
3. **Descend** — gradient-descent step with the new node weakly anchored; settle when `‖∇E‖ < ε`.

The old `base/tail/end` distinction is gone. Every row is a "tail" event. A bulk load is just "many tail events in one frame."

### Cursor semantics
A single **history cursor** points to the row most recently applied. The derived graph state is `replay(history[0..cursor])`. Z moves the cursor backward. New actions insert rows at the cursor (creating a branch if the cursor wasn't at the end).

### Cinematic mode
A visual mode that, when new rows arrive from a live producer (Type B), zoom-tours to each newly-added visible node with a stroke-highlight. Purely aesthetic. Orthogonal to the history mechanism.

---

## 12. Server / Tooling

- `depgraph-server.mjs` — HTTP + SSE + file watching + agent endpoints. Configured via `inspect.json`:
  ```json
  { "name": "depgraph", "src": "./prototypes/index.html", "codemap": "./runtime/depgraph.md" }
  ```
  Server endpoints:
  - `GET /` — SPA static files
  - `GET /history-events` — SSE tail of `history.csv`
  - `GET /focus-events` — step-debugging overlay (sugar)
  - `GET /agent/read?depth=N` — derived state as JSON, bounded by depth
  - `POST /agent/append` — validate + attribute + insert history rows
  - `GET /agent/explain?node=X` — NL description from local graph walk
  - `GET /agent/subscribe` — SSE proxy with optional author/layer/cursor filters
  - `GET /agent/rules` — list available rewrite rules
- `stream/streamer.mjs` — standalone replay server on port 3801.
- `rules/*.json|.mjs` — rewrite rule definitions (pattern + replacement).
- `codegen/*.mjs|.py` — producers; each is a standalone CLI that appends to `runtime/history.csv`.

---

## 13. Scale to Infinity — Physics Without a Ceiling

The VISION calls for "an infinite, continuously updating relational state." v1 will run on 10k nodes; the architecture must not dead-end at 100k or 10M. Every layer has a scaling story.

### Hierarchical spatial index (Barnes-Hut / quadtree, octree-ready)
Per-pair repulsion is O(N²). For any N beyond ~5k, the engine uses a **Barnes–Hut approximation**:

- A quadtree (2D) or octree (3D) aggregates nodes into regional centers-of-mass.
- Repulsion between a node and a distant aggregate is computed against the aggregate, not each child.
- The θ parameter trades accuracy for speed; it lives in `WorkingContext` like any weight.

This makes the gradient-descent step (§8) **O(N log N)** per tick. The same tree accelerates collision checks, nearest-neighbor queries, and rendering culling.

### LOD physics — simulate only what is alive
- Nodes **off-screen and far** are frozen: their gradient is not computed.
- Nodes **off-screen but adjacent** to on-screen content tick at reduced rate (every 4th frame).
- Nodes **inside a collapsed cluster** don't tick; the cluster ticks as a single body.
- Nodes **inside the focused depth** tick every frame.

Frozen nodes contribute to aggregates in the Barnes-Hut tree but cost zero per-frame work themselves. This is how a 10M-node graph animates without burning the CPU on invisible atoms.

### Windowed rendering
The viewport queries the spatial index for the **visible set** (with a small halo). Rendering, event wiring, and DOM joins only touch that set. A zoom-out swaps in a coarser set at the next depth of the quadtree. Rendering cost scales with **viewport pixels, not graph size**.

### Streaming-friendly persistence
`runtime/history.csv` grows unboundedly. Two mechanisms keep it tractable:
- **Snapshots**: periodically, the server writes a `snapshot@t.csv` that represents the derived state at cursor `t`. Loading = latest snapshot + tail rows. Old rows are archived, not lost.
- **Segmented history**: history.csv rotates at N million rows into numbered segments; the cursor addresses (segment, offset).

### Derivative caches with dirty-propagation
Hyperedges, affinities, clusters (§3) are recomputed lazily. A change to one edge invalidates:
- its two endpoints' affinities,
- the hyperedge it belongs to,
- the cluster(s) those endpoints are in.
Dirty flags propagate; only invalidated derivatives recompute. Changing `W` invalidates all affinities but nothing else — clusters rebuild from cached affinities.

### Hierarchical physics at every depth
Each expanded cluster owns its own local quadtree + gradient descent. A super-cluster's physics treats child clusters as soft bodies whose centers-of-mass come from their local trees. **The same algorithm runs at every depth** — recursion gives infinite scale for free.

### What v1 ships
- Barnes-Hut 2D quadtree (ready-to-swap octree interface).
- LOD freeze for off-screen nodes.
- Viewport culling in render pipeline.
- Dirty-propagation for derivatives.
- Snapshot + tail loader.

### What v1 defers
- Multi-worker physics sharding (one quadtree per worker thread).
- Disk-backed node store for >1M graphs.
- WebGPU compute for per-frame gradient eval.

All are additions to the existing interfaces, not rewrites.

---

## 14. AI Agency — The Graph Talks Back

The VISION is unreachable without non-human participants. The graph is too big, too fast, and too multi-dimensional for one human to shepherd alone. AI agents are **first-class users** of depgraph, reading and writing through the same primitives.

### Why AI understandability is a design constraint
Every decision in this spec — two primitives only, unified history, derivatives not stored, context as input — makes the graph legible to an agent with a context window. An agent can:
1. Read `history.csv` sequentially (append-only logs are LLM-native).
2. Derive structure with the same rules the UI uses.
3. Write new rows to steer the graph (no hidden API surface).

**Rule: if a capability is not expressible as history rows + context changes, it does not exist.** No back-channel mutations.

### What agents can do (v1 scope + horizon)

| Capability | v1 | Horizon |
|---|---|---|
| Read the graph | parse history.csv, derive state | live subscription to `/history-events` |
| Propose a WorkingContext | write `kind=context` rows with weights + pins + goal | auto-switch when it detects user intent |
| Name clusters / author codemap | generate `memberOf` edges | author/refine the codemap live |
| Explain a node | describe its neighborhood in NL, with citations (edge IDs) | answer "why did this change?" over history |
| Apply rewrite rules | propose a rule; user confirms; rule becomes a history transaction | auto-apply safe rules, flag risky ones |
| Suggest weights | output a `W` vector for a stated goal | online learning from user drags |
| Spatial guidance | suggest drags; write `EDGE layer=suggested-spatial` rows | autonomously arrange regions |

### Agent-shaped interfaces
- `/agent/read` — returns derived state at cursor as JSON (nodes, edges, clusters, context). Sized-by-depth so contexts fit.
- `/agent/append` — POST history rows. Every agent mutation is attributed (`payload.author=agent-name`).
- `/agent/explain?node=X` — returns a natural-language account assembled from the graph by a small local routine (not requiring an external LLM by default).
- `/agent/subscribe` — SSE stream of rows, same wire format as `/history-events`.

Agents are not privileged. They use the same endpoints a second human would. This keeps the threat model simple and the semantics uniform.

### Auditing & provenance
Every row carries `payload.author` — human username, agent name, producer ID, or `system`. The user can filter the cursor timeline by author (`"show me only what I did"`, `"show me what the AI did while I was away"`) and accept/revert agent contributions as transactions.

### AI as observer
In the VISION's terms, an AI has its **own reference frame** — its own WorkingContext. Multiple agents can watch the same graph under different contexts simultaneously. The spec's observer-dependent rendering (§3 WorkingContext) is the mechanism.

---

## 15. Rewrite Rules & Multiway Evolution

The VISION's core dynamics: *"Time, in a hypergraph model, is simply the computational progression of the graph rewriting itself."* v1 supports this in seed form.

### What a rewrite rule is
A **rewrite rule** is a pattern → replacement over the graph:
```
rule R:
  match:   subgraph pattern (nodes + edges with optional constraints)
  produce: new nodes + edges to add/remove
  where:   predicate on matched bindings
```

Applying `R` at a match site is a **transaction**: a bundle of `NODE add/remove` + `EDGE add/remove` rows appended to `history.csv` with a common `payload.rule=R` tag. Rules can be authored by humans (markdown/JSON) or by agents.

### Rules in v1: code-specific seeds
- `extract-function`: match a subgraph of calls+reads+writes; replace with a single callable node and memberOf edges.
- `inline-function`: inverse of extract.
- `rename`: change a node's label; rewrite incident edge labels.
- `merge-clusters`: fuse two clusters into one.
- `split-cluster`: break one cluster at a cut set.

These are refactorings. v1 does not auto-apply them — it surfaces them as suggestions in a side panel. The user (or an agent) commits.

### Multiway evolution (branches are forks of reality)
The history-cursor branches from §10 are the v1 form of the VISION's "Multiway View." When a rule applies at a match site but there are **multiple valid bindings**, each binding produces a sibling branch:

```
cursor t=100 ──► apply rule R
                 ├─► branch A (binding 1)
                 ├─► branch B (binding 2)
                 └─► branch C (binding 3)
```

Branches are first-class in history.csv; navigating between them is the same cursor mechanism as time travel. A user (or agent) can compare branches side-by-side — the comparison mode promised by the old X/Z controls is revealed as a multiway view.

### The runtime IS the rewrite
The README prophesies: *"The graph doesn't observe execution — it IS execution."* In v1 we stay modest: rewrite rules are offline refactorings. But the architecture encodes the horizon — a rule that fires when its match appears is indistinguishable from a live runtime event. When producers start emitting rule-application rows instead of raw AST diffs, execution *is* rewrite.

### Rule storage
Rules live under `rules/` as JSON or MJS files. They are loaded by the server and exposed via `/agent/rules`. They are NOT in `history.csv` — the history contains *applications* of rules, not the rules themselves.

### What v1 ships
- Rule pattern-matcher (small graph isomorphism against the derived state).
- A library of ~5 code-refactoring rules.
- Suggestion panel: "Apply rule R here?"
- Rule-tagged transactions in history.
- Branch navigation between rule-application alternatives.

### What v1 defers
- Automatic rule application.
- Learned rules (agents writing new rules from observed user behavior).
- Rule composition / rule-of-rules.
- Runtime-tied rules that fire on live events.

---

## 16. Lessons Learned (must not repeat)

From [docs/reviews/REVIEW_2.md](docs/reviews/REVIEW_2.md):

1. **No parallel state.** `savedPositions` / `stickyNodes` / `lockedNodes` drifted. Single `PositionState`.
2. **No duplicate centroids.** `clusterCentroid` lived in physics and rendering — they diverged. One function, one caller set.
3. **No inline soft-collision.** `softCollide()` was reimplemented 4 times. Extract once, parameterize.
4. **No bundled `renderHulls()+renderClusterLabels()` call sites.** Introduce one function, use everywhere.
5. **No `applySemanticZoom` as a DOM god-function.** It currently does navigation + rendering + visibility + opacity. Split.
6. **No 13 uncoordinated RAF loops.** Central scheduler.
7. **No `setTimeout`/`setInterval` without a cancel registry.** Every timer has an owner that cleans up on mode-exit.
8. **No sentinel `-1` RAF ids.** Use `null` + strict check, or a Loop abstraction that owns the id.
9. **No zoom-as-navigation coupling.** Zoom scales the camera. Navigation (expand/collapse, level change) is explicit.
10. **No storing derived state.** `cluster` on a node, `affinities` as a field — both drifted. Derivatives are recomputed, never stored.
11. **No `user-actions.csv` next to `history.csv`.** One table, one cursor. Splitting streams means two places to replay from.
12. **No confusing X with Z.** X is a restoring force in space. Z is a restoring force in *time*. Keep them in separate modules.
13. **No hardcoded layer weights.** Weights live in the WorkingContext and are user-tunable. Constants belong only as defaults.
14. **No breakpoint zoom tables.** Replace with screen-radius LOD + context pins.

---

## 17. Glossary

- **Affinity** — *computed* fractional membership of a node across groups; derived from incident edges under the current weight vector `W`. Sums to 1.
- **Agent** — an AI participant that reads/writes the graph through the same primitives as a human. Has its own reference frame (§14).
- **Attractor** — hold-to-pull interaction on a single anchor node.
- **Barnes-Hut** — O(N log N) spatial-index approximation for repulsion/collision. Quadtree in 2D, octree in 3D (§13).
- **Branch** — alternate history chain created when the user acts (or a rule applies) while the cursor is in the past. Foundation of multiway evolution.
- **Cluster** — 2nd derivative: a hyperedge promoted to a node. Recurses because clusters are nodes.
- **Context (Working Context)** — the vector of weights + pins + focal set + goal that lenses the hypergraph for a given task. §3. Also: the observer's reference frame.
- **Cursor** — the current position in `history.csv`. The graph state equals `replay(history[0..cursor])`.
- **Derivative (d¹, d², …)** — a value computed from edges (and weights). Never stored as primary state; always recomputable.
- **Dirty propagation** — incremental invalidation of cached derivatives when a single edge or weight changes (§13).
- **Fractal descent** — walking down the recursive hierarchy by crossing on-screen-radius thresholds, with cluster pins overriding radius.
- **Gather** — Space-triggered pull of a set toward an anchor or centroid. Adds a temporary term to the energy function.
- **Gradient descent** — the layout engine. Minimizes an energy `E(positions, W)`. Replaces per-force loops.
- **History** — the unified event log `runtime/history.csv`; only two row types (NODE, EDGE); only mechanism of persistence.
- **Hyperedge** — 1st derivative: equivalence class of edges sharing a common member.
- **LOD (level of detail)** — physics and rendering fidelity varies by screen relevance: focused=full, off-screen=frozen, collapsed=point-mass.
- **Manifold** — the high-dimensional surface defined by edges + W; screen positions are its projection.
- **Meta-edge** — aggregated inter-cluster edge; a `group-by` projection of primitive edges at a given depth.
- **Multiway** — multiple branches evolving simultaneously from the same cursor point; the graph's analogue of parallel timelines.
- **Observer** — a context holder (human or agent). What you see depends on your reference frame (`W`, pins, focal set).
- **Pinning** — per-context instruction to keep a cluster collapsed (or expanded) regardless of screen radius.
- **Primary cluster** — `argmax` of a node's affinities under current `W`. Dynamic.
- **Projector** — the function `π(Ψ(n)) → ℝ²` (or ℝ³) that maps manifold positions to screen coordinates. Pluggable (§8).
- **Rewrite rule** — a pattern → replacement over the graph. Applied as a transaction of history rows (§15).
- **Snapshot** — a checkpoint of derived state at cursor `t`; enables fast loading without full replay (§13).
- **Sticky** — node whose gradient is dampened; moves slowly under descent.
- **Streaming (Type A)** — always-on append of user actions to history. Enables offline time-travel.
- **Streaming (Type B)** — optional SSE push of live code-update rows into history.
- **T0** — initial-layout positions; target of X-reset.
- **Time travel (Z)** — moving the history cursor backward. Works without either streaming type.
- **Transaction** — a bundle of history rows from one rule application or agent action. Atomic: accept/revert as a unit.
- **Viewport culling** — rendering only the visible set from the spatial index, not the full graph (§13).
- **W (weight vector)** — per-layer weights for affinity, physics, and opacity. Depends on context. `W = f(context)`. Itself tunable (2nd derivative of weights).
- **X-reset** — hold-to-decay positions toward T0 and weights toward context defaults. Not time travel.

---

## 18. Rebuild Checklist (order of operations)

1. **Scaffold.** Module layout from §6. JSDoc types for Node, Edge, WorkingContext, HistoryRow. Empty stubs.
2. **Core loop.** `core/state.js`, `core/animation.js`, `core/bus.js`. Prove one RAF tick with a dummy node.
3. **History first.** `data/history.js` + `data/csv.js`: append, replay, cursor, branches. Test with a synthetic history file. **No UI yet.**
4. **Derive.** `data/derive.js`: given rows + `W`, produce `{nodes, edges}`, hyperedges, affinities, clusters. Verify via console that changing `W` changes primary clusters.
5. **Context.** `core/context.js`: default context, named presets, `W` vectors. Changing context emits on the bus.
6. **Placement.** `layout/manifold.js` + `layout/gradient.js`. Settle a tiny graph via gradient descent. Verify sticky/locked gradient clamping.
7. **Render basics.** `render/svg.js` + `render/nodes.js` + `render/edges.js`. Static frame.
8. **Fractal rendering.** `render/hulls.js`, `render/meta-edges.js`, `render/labels.js`; recursive `renderGraph(depth)` with screen-radius LOD and cluster pins. No zoom breakpoints.
9. **Interaction.** `interact/select.js` + `drag.js`. Each mutation writes to `history.js`. Confirm history replay reproduces the session.
10. **Modes.** Attractor, gather, trace, reset (X), time-travel (Z). Each mode = term added to E, or a cursor move. Each write is a history row.
11. **Streaming Type A (always on).** Verify time travel works with no server.
12. **Server + Streaming Type B.** SSE tail of history.csv. Live producer appends rows; clients react identically to user-produced rows.
13. **Producers.** Migrate `codegen/*` to append to history.csv. Freeze history schema.
14. **Context UI.** Weight sliders per layer (affinity / physics / opacity), presets, pin toggles.
15. **Quadtree + viewport cull.** `layout/quadtree.js` + `render/viewport.js`. Confirm 5k nodes renders at 60fps with off-screen freeze.
16. **Snapshot + tail loading.** `data/snapshot.js`. Write a snapshot at cursor 0 on first load; subsequent loads use snapshot + tail. Confirm load time under 500ms for 10k-row history.
17. **Rules engine.** `rules/matcher.js` + `rules/library.js` + `rules/apply.js`. 5 code-refactoring rules. Manual confirm via suggestion panel.
18. **Agent endpoints.** `agent/read.js`, `agent/append.js`, `agent/explain.js`, `agent/subscribe.js`. Confirm an LLM can read derived state, propose a context, and write attributed rows.
19. **Branch navigation.** Alt+Up between rule-application branches. Side-by-side comparison of two branches.

### Ship when (v1)
- Time travel works with SSE off, with no server, with only user-produced history.
- Changing `W` shifts clusters visibly without rebuild (dirty propagation, not full re-derive).
- One clear answer to "why is this node (in)visible" — a single `isVisible(node, context, cursor)` function.
- Zero stale RAFs, zero conflicting position writes.
- 10k nodes at 60fps with viewport culling + Barnes-Hut.
- An AI agent can round-trip: read graph, propose context, write back rows, see the effect.
- A rewrite rule can be previewed and committed as a history transaction.
