# Depgraph Rebuild Spec

## What it is
Single-file HTML tool that visualizes the dependency graph of `prototype/index.html`. Parses the game's JS via Acorn AST, combines with `project_codemap.md` sections, renders an interactive node graph.

## Data Pipeline

### Inputs
- `prototype/index.html` — the game source, fetched via HTTP
- `tools/project_codemap.md` — manually curated sections grouping functions into systems

### AST Analysis (`analyzeCode`)
- Extracts the `<script type="module">` block
- Pass 1: collect top-level declarations → `globals: Map<name, {kind, line}>`
- Pass 2: for each function → `{reads, writes, rw, calls, params, locals, line, endLine, lines}`
- `reads/writes/rw` = which globals the function touches
- `calls` = which other top-level functions it calls

### Codemap Parsing
- `## Section Name` headings define systems (NPCs, Terrain, Night/Combat, etc.)
- `- \`funcName\`: ~line importance:N` entries assign functions to systems + importance (node size)
- 15 systems, ~128 functions, ~185 constants

### Multi-System Affinity Scoring
Each node gets `affinities: Map<clusterId, weight>` (normalized to sum=1.0) from 5 signals:

| Signal | Weight | Source |
|--------|--------|--------|
| Codemap section | 5.0 | Manual assignment (strongest) |
| Name tokens | 1.5 each | camelCase split → keyword lookup |
| Globals read/written | 0.5 each | underscore split → keyword lookup |
| Functions called | 0.3 each | Callee's primary cluster |
| Called-by | 0.2 each | Caller's primary cluster |

Keyword table maps ~40 tokens to systems (e.g. `terrain` → Math/Noise/Terrain, `ghost` → Night/Combat).

Globals get affinities from naming (weight 2.0) + connected functions' clusters (1.0 each).

Primary cluster = highest-weight affinity. Used for hull membership, node color, legend.

## Layout Requirements

### Clusters must have hard boundaries
- Each cluster has a bounding region (convex hull or circle)
- **Clusters cannot overlap** — there must be a visible gap between all cluster boundaries
- When nodes move (drag, attraction), their cluster boundary follows in real time
- Foreign clusters get pushed away as rigid bodies to make room

### No ambient physics
- After initial layout settles, **everything is static** — no springs, no jiggling, no drift
- Clicking/selecting a node must NOT cause other nodes to move
- Dragging a node moves only that node (and attracted neighbors during hold)
- Press **X** to re-run layout if needed (explicit user action)
  - Re-running the layout should be smooth, 
  - Manually positioned nodes should stay "sticky" in their position (up to a time/memory? Perhaps we should create new links/edges here)

### Sticky positions on file change
- When source file changes and graph rebuilds, nodes that still exist keep their positions
- Only new nodes get placed fresh
- Warm restart should be nearly invisible — micro-adjustment, not full re-layout

### Live reload toggle
- Toolbar checkbox "Live" — when unchecked, no fetching/parsing/rebuilding occurs
- Status shows "paused" when off

## Interaction

### Click
- Select node → opens info panel with: location, system, affinities (colored bars with %), reads, writes, calls
- No physics disturbance whatsoever

### Drag
- Moves the single node directly (position update, n+1 is attracted too softly, n+2 might be attracted too (more softly))
- Updates links/labels/hulls in real time

### Press-and-hold (Attractor)
- Hold a node → its direct neighbors get pulled toward it
- Pull strength ramps over ~2 seconds
- Neighbors resolve collisions between each other (no stacking)
- The held node's cluster hull follows the moving nodes
- **Other clusters push away as rigid bodies** when hulls would overlap
- Release → positions freeze exactly where they are (locked state)
- **SPACEBAR** → release lock, positions stay

### Semantic Zoom
- Zoom out: cluster labels large, function labels hidden, edges faint, hulls more visible
- Zoom in: function labels appear (sized to fit inside nodes), cluster labels fade, edges visible
- Labels are always `pointer-events: none; user-select: none` — never block clicks

## Visual

### Nodes
- Functions: colored by primary cluster, radius from importance
- Globals (hypergraph mode): dark gray (#333), radius from usage count
- Secondary affinities ring: stroke-only circle in secondary system color, shown when secondary >= 5%, stoke thickness for affinity %

### Edges
- Shared state: blue (#4a9eff)
- Function calls: green (#af6)
- Global uses (hypergraph): dashed
- Density-adaptive opacity: high-degree hub edges fade (depends on view mode, perhaps togglable?)

### Hulls
- Convex hull per cluster, expanded by 20px padding
- Fill with cluster color at low opacity
- Update every frame during interaction (drag, attraction)

### Cluster Labels
- One per cluster, positioned above cluster, away from other nodes/clusters, ideally in "deadspace" 
- Font scales inversely with zoom (always readable)

### Info Panel
- Right sidebar, slides in on node click
- Shows: location, system, affinity bars, reads/writes/calls
- For globals: shows which functions use it and how (read/write/rw)

## View Modes
- **Hypergraph (default)**: functions + global variable nodes, edges show usage relationships
- **Systems (clustered)**: function nodes grouped by codemap section
- **All functions**: flat view of all functions

## Toolbar Controls
- View mode selector
- Edge mode: shared state / function calls / both
- Labels toggle
- Clusters (hulls) toggle
- Live reload toggle
- Min shared threshold slider
- Search by function name

## Tech Stack
- Single HTML file, no build step
- Acorn (CDN) for AST parsing
- Rendering: **your choice** — D3 force layout has proven to be fundamentally unsuitable for this use case. Consider:
  - Pure canvas/SVG with manual layout (e.g. force-directed in a web worker, frozen on completion)
  - Pre-computed layout (run physics offline, render static positions)
  - Constraint-based layout (clusters as non-overlapping bounding boxes placed first, then nodes within)
  - ELK.js or Dagre for structured graph layout
  - Or any approach where the layout is computed once and then the result is static

## Key Files
- `tools/depgraph.html` — the tool (rebuild target)
- `tools/project_codemap.md` — system sections + function importance
- `prototype/index.html` — the game source being analyzed

## Spatial Memory & Arrangement Navigation

The layout is not just a computed output — it's a **document** that accumulates context over time. User interaction produces spatial knowledge that should persist, be navigable, and influence future layouts.

### Three layers of layout input

| Layer | Source | Persistence |
|-------|--------|-------------|
| Structure | AST (calls, shared state) | Recomputed from code |
| Semantics | Codemap + affinity scoring | `project_codemap.md` |
| Spatial memory | User interaction over time | `depgraph-spatial.json` |

### Spatial affinity edges
A new edge type that doesn't come from the AST — it comes from interaction. When the user drags nodes together, clicks nodes in sequence, or uses the attractor to pull neighborhoods together, this creates **spatial affinity** between those nodes. Over time, nodes the user mentally associates become physically closer in the default layout, even if they're in different codemap systems.

Signals that build spatial affinity:
- **Click co-occurrence**: clicking node A then node B within ~30s → co-occurrence event
- **Drag proximity**: user manually places A near B → strong spatial signal
- **Attractor grouping**: pulling B toward A → explicit association
- **Frequency weighting**: repeated associations strengthen the edge, old ones decay

These edges are stored and influence layout: nodes with strong spatial affinity get placed closer, potentially overriding pure cluster membership for positioning (while still keeping their cluster color/hull).

### Arrangements as snapshots
Each meaningful layout state is an **arrangement** — a `Map<nodeId, {x, y}>` plus metadata:
- Timestamp
- Focal nodes (what the user was looking at)
- Auto-generated label (e.g. "terrain-npc interaction")
- How it was created (drag, attractor, re-layout, file change)

Arrangements are pushed onto a **navigation stack** as the user interacts.

### Arrangement navigation (Back/Forward)

Navigate between arrangements like browser history:
- User explores default layout → arrangement A
- Drags Night/Combat nodes toward Terrain → arrangement B (pushed)
- Clicks NPC node, attractor pulls neighborhood → arrangement C (pushed)
- **Back** → smooth transition to arrangement B
- **Back** again → smooth transition to arrangement A
- **Forward** → smooth transition to arrangement B

Transitions between arrangements are animated interpolations of node positions (lerp over ~300ms).

### Layout merging & comparison view

When the user navigates **back/forward repeatedly** (oscillating between two arrangements), the system detects this pattern and enters a **comparison mode**:

- The two arrangements are **merged** into a single view
- Nodes that exist in both arrangements but at different positions are shown with their **differences exaggerated** — pulled further apart to highlight what's structurally different between the two views
- Nodes that are in the same position in both arrangements stay put (they're the "common ground")
- Edges/connections that are unique to one arrangement's focal context could be color-coded or emphasized
- The result is a diff-like view of two exploration contexts, showing what the user was comparing

This is analogous to how a diff highlights changes between two files — the comparison view highlights changes between two ways of looking at the same graph.

Detection heuristic: if the user does back→forward→back within ~3 seconds (oscillating), trigger comparison mode. A third arrangement navigation or clicking away exits it.

### Persistence format

`tools/depgraph-spatial.json`:
```json
{
  "arrangements": [
    {
      "id": "a1b2c3",
      "timestamp": "2026-03-21T...",
      "positions": {"getTerrainY": [120, 45], "moveNPC": [135, 50], ...},
      "focal": ["getTerrainY", "moveNPC"],
      "label": "terrain-npc interaction",
      "trigger": "attractor"
    }
  ],
  "spatialEdges": {
    "getTerrainY\u0000moveNPC": {"weight": 0.7, "lastSeen": "2026-03-21T..."},
    ...
  },
  "clickLog": [
    {"node": "getTerrainY", "t": 1711036800000},
    {"node": "moveNPC", "t": 1711036812000}
  ]
}
```

Spatial edges decay over time (half-life of ~1 week?) so stale associations fade. The click log can be truncated to last N entries. Arrangements could be capped (e.g. last 50) with older ones pruned.

### How spatial memory influences layout

During the constraint-based layout step:
1. Pack clusters into non-overlapping regions (structural)
2. Within each cluster, place nodes by importance (semantic)
3. **Adjust positions** by spatial affinity — nodes with strong spatial edges get pulled closer, potentially across cluster boundaries (the node stays in its hull but shifts toward the hull edge nearest its spatial neighbor)
4. If a saved arrangement exists for the current node set, use it as the starting point instead of computing fresh

## What went wrong with D3 force layout
- Forces fight each other: cluster attraction vs cluster separation vs link forces vs collision → unstable equilibrium
- Any interaction (click, drag) re-injects energy that cascades through the whole graph
- `velocityDecay` dampens useful forces (separation) alongside harmful ones (jitter)
- Warm restart after file change either does nothing (alpha too low) or explodes (alpha too high)
- Cluster boundaries require rigid-body semantics that D3 force simulation fundamentally cannot express
- The force model is continuous/analog but we want discrete/static with occasional controlled transitions
