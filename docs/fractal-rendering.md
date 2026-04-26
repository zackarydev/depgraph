# Fractal rendering

Per-node level-of-detail driven by zoom and cluster nesting. As the camera
zooms in, clusters expand into their members; expanding a cluster reveals
sub-clusters that themselves expand at deeper zooms. The same data drives
every level — there is no parallel "abstraction graph". A function and its
implementation live in one hypergraph; the renderer just hides whichever
levels are not currently in scope.

## Data model

The substrate has only nodes and edges. A "fractal level" is a `memberOf`
edge: the source is a member of the target cluster. The cluster derivation
(`src/data/derive.js`) turns those edges into `Cluster` records keyed
`cluster:<targetId>`.

Nesting works because cluster targets are themselves nodes:
- `tok_X` has `memberOf` → `L2_args` (so `cluster:L2_args` exists, members
  include `tok_X`).
- `L2_args` has `memberOf` → `L1_args` (so `cluster:L1_args` exists,
  members include `L2_args`).
- `L1_args` has `memberOf` → `add` (so `cluster:add` exists, members
  include `L1_args`).

Walk those parent links from any node and you get a path to the root. The
length of that path is the node's **fractal level**.

```
add (level 0, cluster:add)
└── L1_args (level 1, cluster:L1_args)
    └── L2_args (level 2, cluster:L2_args)
        └── tok_X (level 3, atom)
```

The hierarchy must be **uniform**: every atom at the deepest level should
be the same depth from the root. This lets a single zoom-vs-level table
gate visibility for the whole graph. If one branch goes `root → atom` in
2 hops and another goes `root → ... → atom` in 3 hops, the 2-hop atoms
will pop into existence at the wrong zoom.

To make a degenerate intermediate level uniform, insert a single-member
cluster (e.g. `L1_decl` → `L2_func` → `tok_func`, where `L2_func` exists
just to keep the depth at 3).

> Caveat: `deriveClusters` double-prefixes any `memberOf` target that
> already starts with `cluster:`, so don't write `memberOf(child,
> 'cluster:add')`. Use a plain id; the derivation produces `cluster:add`
> automatically.

## LOD pass

`src/render/fractal-lod.js`:

- `LEVEL_THRESHOLDS` — array indexed by level, each entry the minimum
  zoom (`k`) at which that level becomes the active depth. Default
  `[0, 1.5, 3.0, 6.0]` so at default boot (k=1) the user sees the
  collapsed root and zooms in to reveal levels.
- `currentMaxLevel(k)` — given a zoom, returns the deepest visible level.
- `computeFractalLevels(clusters, nodes)` — returns `{ levels,
  clusterTargets, maxLevel }`. `levels.get(id)` is the node's depth;
  `clusterTargets` is the set of node ids that have a derived
  `cluster:<id>` (so they collapse to a single representative when their
  cluster isn't expanded). Walks the `memberOf` parent chain via
  `memberToCluster` plus a strip of the `cluster:` prefix.
- `applyFractalLod(state, deps, k)` — toggles `display` on the renderer's
  DOM element maps:
  - **node**: hidden if level > maxLvl, or if it's a cluster target whose
    level < maxLvl (its members have taken its place).
  - **edge**: hidden if either endpoint is hidden. Edge keys are
    `e:<edgeId>` for regular edges and `m:<clusterA>\0<clusterB>` for
    aggregated meta-edges; both branches are handled. The matching arrow
    path is hidden alongside the line.
  - **hull**: shown only for clusters whose level < maxLvl (so their
    members are out and the hull encloses something visible).
  - **cluster label**: same rule as hulls.
  - **labels of currently-visible nodes**: opacity forced to 1 so the
    sole representative at low zoom is legible. This overrides
    `applySemanticZoom`'s screen-radius fade, which otherwise hides the
    label of an isolated cluster representative (`screenR < 6 → 0`).

The LOD pass caches on `state._lastFractalMaxLevel` so display toggles
only run on level transitions, but the label-opacity override runs every
zoom event so applySemanticZoom can't fade it back out.

## Render integration

- **renderFull** (`src/render/v3.js`) computes `state.fractalLod` from the
  current derivation and runs `applyFractalLod` once at the end. Resets
  `state._lastFractalMaxLevel = -1` to force the post-render pass to
  toggle every element.
- **zoom handler** (`src/main.js`) calls `applyFractalLod` after
  `applySemanticZoom` on every zoom event. No re-render is needed; the
  pass just flips DOM visibility.

Because we use `display:none`, hidden nodes still occupy positions in the
posMap and still participate in physics. Pop-in/pop-out is therefore
stable — when an L2 cluster expands, its members appear at their already-
settled positions, not at a random seed.

## Authoring a fractal demo

Use `src/data/demo-add-fractal.js` as the template.

1. **Build the cluster tree top-down.** Start with one root id (a plain
   string, no `cluster:` prefix). Add `addNode(rootId, 'cluster', label,
   importance)` so it has a DOM element to display when alone.
2. **Define each interior level as nodes that are both cluster members
   and cluster targets.** A node at level L is `addNode`'d, gets a
   `memberOf` edge to its level-L-1 parent, and is itself the target of
   `memberOf` edges from its level-L+1 children.
3. **Make the depth uniform.** Insert single-member intermediate clusters
   if a branch would otherwise be shallower than the others.
4. **Author positions** in a `POSITIONS` constant exported from the
   module. Each child should sit inside its parent's footprint — this is
   what gives the demo its "code-like" look at every zoom level.
5. **Wire the demo in `main.js`**:
   - Add a generator entry to the `opts.demo` switch (`generators[name]`).
   - Apply the positions after `initialPlace` and `setSticky` them.
6. **Boot it**: `?demo=<name>` appended to the URL.

For the `add` example the layout convention is:
- L1 signature (`L1_decl`, `L1_args`, `L1_ret`) on the top row
  left-to-right, `L1_body` directly below.
- L2 signature pieces on the same row as their L1 parent.
- L2 body statements stacked vertically like source-code lines.
- L3 atoms within their L2 parent's local x-range, kept on the same y as
  the parent so a row of tokens reads like a line.

Gradient descent is left enabled (positions are sticky, not locked), so
when the user drags or appends rows the descent can rebalance — but the
authored layout is the attractor it relaxes toward.

## Known limitations / future work

- **Lock fractal height.** No UI yet to pin `currentMaxLevel` so the
  user can pan/zoom around a chosen depth without revealing more.
  Likely a small addition that sets `state._lockedFractalLevel` and has
  `applyFractalLod` substitute it for `currentMaxLevel(k)`.
- **Hard transitions.** Levels switch instantly at threshold crossings.
  Smooth fades would require interpolating opacity through a transition
  band rather than the current display-toggle.
- **Stale hulls of hidden clusters.** Hulls are recomputed from member
  positions on every full render; if a cluster's members are hidden, the
  hull computation still uses their last-known positions. The LOD pass
  hides the hull but the geometry isn't refreshed, so a cluster with no
  visible members yet has a phantom hull underneath. Acceptable while we
  rely on `display:none`; a real fix is to skip hull build for fully-
  collapsed clusters.
- **Per-node visibility ranges.** Only the `memberOf` chain decides
  visibility. There's no way to say "this node appears at L2 but not at
  L3" — a node is visible at all levels ≥ its own. The "additive"
  variant (where deeper levels reveal *new* content not present at
  shallower levels) needs a per-node `[minLevel, maxLevel]` field.
- **Dynamic loading.** The whole tree is in memory. A future expansion
  would load deeper levels on demand using sentinel marker nodes, so a
  graph with many fractal layers doesn't cost RAM for layers nobody is
  looking at.
