# Runtime Rules

The conceptual model under depgraph. This doc pins the vocabulary before any of it
gets baked into code. It is not a spec, not an implementation plan, and not tied
to JavaScript.

The model has four primitives and one substrate. Everything else — types, kinds,
capabilities, control flow, debugging, refactoring, the editor — is observed
behavior of those primitives interacting under a set of rewrite rules.

---

## Primitives

### Node

An identity. A position. Optionally, a value.

A node has no `kind`, no `type`, no `capability` flag. It is a thing-with-a-place.
What we colloquially call its kind ("function", "value", "cluster") is not stored
on the node — it is observed by looking at which rules can fire on it.

A node's value, when present, is metadata for visualization. The number `56` is a
node whose value is `56`; the string `"hello"` is a node whose value is `"hello"`.
Two distinct nodes can share a value without being the same node — identity is
not equality.

### Edge

A directed (or undirected) connection between nodes. An edge carries a *rule
binding* — a reference to one or more rewrite rules that consume it. The edge's
behavior is defined by the rules it participates in, not by an enum of edge
types.

What we call a `call` edge or a `parameter` edge is just an edge that happens to
be wired to the call rule or the parameter-binding rule. Rename the rule and
the edge's "type" changes, because there was never a type — only the binding.

### Hyperedge

A set of edges that must be considered together by a rule. Where an edge is a
binary relation, a hyperedge is the n-ary relation that bundles the participants
of a single rule firing.

A function call hyperedge bundles: the function-node, its parameter-slot nodes,
its body-root, the return port, the calling frame. The call rule reads that
bundle as a unit. Without the bundle, the rule cannot fire — the participants
are individually meaningless.

### Rule

A pattern over hypergraph structure plus a transformation. Preconditions: which
nodes, edges, hyperedges, and values must be present and in what relation.
Postconditions: what exists after the rule fires.

Rules are themselves nodes in the hypergraph. They can be visualized, dragged,
and (eventually) edited by the same gestures used for any other node. This keeps
the door open to meta-rules — rules that fire on configurations of other rules.
v1 does not need to expose this UI, but the schema must permit it from the start.

A rule has three parts:

- **Match**: a structural pattern with named bindings ("there exists a node F
  with an incoming `call` edge from a frame node, and parameter slots holding
  runtime nodes V[0..k]")
- **Conditions**: predicates on the bound values ("V[0].value is a number")
- **Rewrite**: the transformation ("emit a new runtime node W bound to F's body,
  remove the call edge, add a return edge from F to the calling frame")

Rules are pure functions of hypergraph state. Side effects in the outside world
(file writes, network IO, screen pixels) only happen when special **boundary
rules** fire — see *Sentinels*, below.

---

## Substrate

The single thing all four primitives live in: the **history log**. An append-only
sequence of NODE and EDGE rows. The current state of the hypergraph is
`replay(history[0..cursor])`. Nothing else is primary; everything else (positions,
clusters, derived edges, even rule firings) is computed from that log.

Branches in history correspond to forks in time — the multiway-systems model.
The cursor can be moved freely; per-region cursors are a future extension that
let different parts of the canvas live at different points in time.

---

## Distributed substrate and wave propagation

The hypergraph is too large to fit in one process for any non-trivial system.
Materialization is lazy and frontier-driven: as the wave of active rule firings
expands outward from sentinels, regions are faulted in from disk or from peer
servers on demand. A region that no rule has touched in some time is unloaded.

The execution **wave** is just the set of currently-firing rules. It propagates
outward along the edges those rules consume. New regions become "hot" the moment
the wave reaches them. The substrate has to deliver them before the next tick or
the wave stalls — which makes the loading path latency-critical.

In a multi-server deployment, the wave will sometimes cross server boundaries
mid-tick. Two consequences are unavoidable:

- **Handoff jitter.** The receiving server lags briefly. Runtime nodes near the
  boundary either pause (frame stalls) or proceed with stale neighbor positions
  (frame races ahead). Both are visible glitches if the substrate is otherwise
  silent.
- **Version skew.** The structural neighborhood being faulted in may have been
  edited since the last time it was paged out. Rules that fired correctly on the
  old structure may not fire on the new one. Reconciliation is a real protocol
  problem with no clean answer; the right framing is probably "structural edits
  are themselves history rows, so reconcile by replaying the edit log on top of
  the cached snapshot."

The trick that makes this tolerable: **the substrate is already noisy**. Inertia
nondeterminism (runtime traffic pushing structure around) means the canvas wobbles
even when nothing is wrong. Loading-induced jitter blends into that ambient
motion. The user perceives a continuous physical scene, not a sequence of
discrete network glitches.

This is the same trick real-time graphics use to hide quantization (dither into
noise) and that netcode uses to hide packet jitter (interpolation between known
states). Here it falls out for free because the simulation already has the noise
budget. We just have to make sure the loading path's noise envelope stays
*within* the substrate's natural envelope. If load latency exceeds substrate
jitter amplitude, the glitch becomes visible — that's the operating constraint
the runtime has to meet.

This will absolutely happen in production. The defense is layered:

- Speculative pre-fetch along likely wave directions (sentinel patterns are the
  prior).
- Structural neighborhood snapshots that travel alongside their boundary edges
  so the receiving server has a usable approximation while the authoritative
  copy is in flight.
- Tick rate that adapts to local substrate health — slow regions naturally drop
  to lower τ, hiding load delays as "this region is computing slowly."

---

## What is deliberately NOT in the model

Listed because the temptation to add them will be constant.

- **No kinds.** No `kind: 'function'`. Function-ness is observed when rules fire
  in the function-shaped pattern. Tagging is a UI concern (color a hull,
  label a region), never an engine concern.
- **No capabilities.** Capabilities are still a fixed taxonomy. Rules are the
  taxonomy.
- **No types.** Type-checking is rule-matching: "is this configuration one that
  any rule can consume?" Invalid code is configurations no rule fires on.
- **No language-specific code in the engine.** JavaScript is a *rule pack* loaded
  on top of the engine. Python is a different rule pack. The engine does not
  know either exists.
- **No hard-coded edge layers.** `calls`, `memberOf`, `shared`, `spatial` are
  conventions used by today's rule packs, not engine concepts.

---

## Worked example: `add(2, 3)` returning `5`

Before evaluation:

```
Structural nodes (high inertia):
  N_add        — the function definition
  N_lit_2      — the source-code literal `2`
  N_lit_3      — the source-code literal `3`
  N_call_site  — the call expression `add(2, 3)`

Structural edges:
  E1: N_call_site → N_add        (callee binding)
  E2: N_call_site → N_lit_2      (arg slot 0)
  E3: N_call_site → N_lit_3      (arg slot 1)
```

A sentinel fires (e.g., the user clicked a "run" button, or the module is being
executed during boot). The boot-rule creates a runtime frame:

```
Runtime nodes (low inertia):
  R_frame      — a frame hyperedge anchored at N_call_site

Runtime edges (in the frame hyperedge):
  R_frame ⊃ N_call_site
```

The literal-instantiation rule fires on each of N_lit_2 and N_lit_3 because they
are inside an active frame:

```
  R_v2  — runtime instance of N_lit_2, value=2
  R_v3  — runtime instance of N_lit_3, value=3

  R_v2 instantiates N_lit_2
  R_v3 instantiates N_lit_3
```

The call rule's match now succeeds: there is a frame, there is a callee, and
both arg slots are populated by runtime values. The call rule fires:

```
  Rewrite:
    - Bind R_v2 to N_add's parameter slot 0 (a sub-frame for N_add)
    - Bind R_v3 to N_add's parameter slot 1
    - Activate the body-rule on N_add's body subgraph
```

N_add's body is itself a subgraph containing the primitive add operation. The
add-op rule reads the bound parameter values and fires:

```
  R_v5  — runtime instance, value=5
  R_v5 produced-by R_v2, R_v3
```

The return rule fires when the body terminates: emit R_v5 along the return port
back to the calling frame, dissolve the sub-frame, dissolve the parent frame
once nothing else depends on it.

Visually, all of this appears as runtime nodes (low mass, light) being pulled
into the function-node's region, briefly residing there, and a new value-node
emerging and migrating back to wherever the call originated. The structural
nodes (high mass, heavy) barely move.

---

## Runtime mechanics

### Inertia

Every node has a `mass` property. Force integration divides accumulated forces
by mass before applying. Structural nodes get mass ~1000; runtime nodes get
mass ~1. Same physics, same code path — but the structure becomes a near-rigid
scaffold and runtime values flow through it.

The split is observable, not declared. A node "is structural" when its mass is
high enough that runtime forces don't move it visibly. A rule pack assigns
masses; nothing in the engine cares.

### Sentinels

Frame hyperedges are not created from a single global origin. They are created
by **sentinels** — boundary rules that fire in response to events outside the
hypergraph:

- **One-shot external**: keyboard event, network response, file-read completion
- **Cyclic external**: animation frames, setInterval, audio buffer requests
- **Cyclic internal**: generators, stream pulls
- **Bootstrap**: a single `origin` sentinel for the initial load

Every runtime node, walked backward through `frame` and `triggered-by` edges,
terminates at a sentinel. "Why did this code run" is a graph walk to a sentinel.
This makes causality first-class.

Sentinels are the only place nondeterminism enters the system. Everything else
is deterministic descent from them.

### Frame lifecycle

A frame hyperedge has a lifecycle that the engine must model explicitly:

- **Push**: sentinel fires → frame created → bound to its triggering edge
- **Active**: rules fire inside the frame's scope; runtime nodes flow
- **Pop**: the frame's terminating rule fires (return, throw, cancellation) →
  frame dissolves → captives are released or migrated to the parent frame

Closures are frames whose `captures` hyperedge persists past the parent's pop.
Async pending operations are frames tagged `suspended`, parked at high gravity
toward a horizon region until a resolution sentinel re-activates them.

---

## Time

### Replay is the default; live is a special case

Execution is recorded as a stream of history rows. The user scrubs through at
any speed. "Live" is just "scrubbing forward at 1.0×".

A `playback_rate` slider with a log scale from `1e-6` to `1e6` covers the useful
range — one tick per microsecond up to one tick per realtime second. Tight loops
and binary sorts live at the slow end; long-running processes live at the fast
end.

### Per-region τ

Playback rate is not global. Each region of space has a local time multiplier
`τ` that scales how fast rules fire there. The central clock dispatches rewrites
with `dt_effective = dt * τ(region)`.

Practical consequence: paint slow over the suspect subgraph, fast everywhere
else, watch the bug at human pace without halting the rest of the system.
Visually, runtime nodes traversing a slow region literally decelerate. In 3D,
gradients become refractions and walls — runtime nodes pile up against time
boundaries.

### Per-region cursors

A future extension. Today the cursor is a single global pointer into history.
Per-region cursors let one region replay a past execution while another stays
live. This is a primary-data-model change (state rebuild has to be partitionable
to a subgraph) and is not in v1.

---

## Visualization

### Value as shape

A circle is a default for "thing of which there are many." Once nodes carry
values, the value should be the visual:

- **Number** → the digits, sized by importance
- **String** → the text in quotes, truncated by LOD
- **Boolean** → a filled or empty mark
- **Array** → a strip of child visuals
- **Object** → a key:value grid
- **Image** → the image
- **Promise (pending)** → a spinner; resolved → the resolved value

The circle survives only as the fallback for "no rule pack provides a render."

### Screen fractal layer

Most execution should not be visible by default. The screen fractal layer is
the layer the user lives in — the layer at the current viewport zoom. Drilling
in is literal zoom; drilling out is also zoom but in the other direction.

There is no show/hide UI. Attention is allocated by zoom. The fractal LOD
machinery already in place does the heavy lifting; the change is a defaults
policy: new runtime nodes start in non-screen layers and become visible only
when the user navigates to them.

### Fractal levels and runtime motion

Runtime motion only makes spatial sense at deep fractal levels. At L3 the
parameter slots, body operators, and return ports all have positions, and a
runtime value flowing left-to-right tells a coherent story. At L0 the entire
function is a single collapsed cluster — there is no internal fabric for a
runtime node to traverse. The naive "render all runtime motion at every level"
either looks wrong (values teleporting in and out of a single cluster) or fails
entirely (no spatial structure to descend against).

The right separation is **physics runs against the deepest available structure;
rendering shows only the visible level.** A runtime node always has a real
position derived from the deep scaffold it is interacting with — even when
that scaffold is hidden because the user is zoomed out. The render layer
projects deep positions to the visible level by collapsing any node whose
position falls inside a hidden cluster's bounding region into that cluster.

Visual consequences at each level:

- **L3 (deepest, expanded)** — runtime nodes appear as discrete dots and visibly
  traverse the body. Full motion legibility.
- **L1/L2 (partial expansion)** — some interior structure is visible, some is
  collapsed. Runtime nodes "enter" collapsed sub-clusters as a brief pulse on
  the cluster boundary, then re-emerge when they cross back into visible
  structure.
- **L0 (collapsed)** — the cluster shows aggregate activity (a glow, a count
  badge, a slight pulse synced to traffic rate). Individual runtime nodes are
  invisible inside, which is exactly the abstraction the user chose by zooming
  out: "function call: input goes in, output comes out, I do not care about
  the internals."

This is correct rather than impoverished. It mirrors how cities visualize
traffic at different zooms: individual cars at street level, flow lines at
neighborhood level, statistics at city level. None is wrong; each matches the
attention level the viewer has chosen.

The unsolved part is **summarization**. At L0, "input goes in, output comes
out" is a true description of `add(2,3) → 5`, but the real win would be
synthesizing higher-level descriptions automatically: "this region performed
arithmetic," "this region serialized data," "this region waited on IO." Two
plausible paths:

- **Rewrite rules at the abstraction layer.** A meta-rule observes that a
  cluster's interior consists of arithmetic primitive firings and labels the
  cluster "computes" for the duration. Rules generate the summaries; the
  engine doesn't need to know what arithmetic means.
- **AI summarizer.** A small model reads the rule firing trace inside a
  cluster and produces a one-line description of what the cluster did during
  this frame. Cheaper to build, opaquer to debug.

Both are open. For now the demo settles for "you can see the L3 motion if you
zoom in" and trusts that the abstraction story at higher levels gets built
later. The substrate is correct; the surface story isn't yet.

---

## The editing feedback loop

Two domains:

- **Source code** — the operational reality. What the machine runs.
- **Hypergraph affinity** — the user's working theory of structure. What the
  user thinks the code's shape should be.

Today these diverge silently. The hypergraph + AI loop keeps them in sync. The
user manipulates affinity directly (drag, separate, merge, delete). A streaming
intent extractor watches the history tail and emits typed intent objects. A
local model (Gemma3 in Docker) consumes the rolling intent buffer plus the
current hypergraph snapshot plus the repository, and emits hypergraph rewrite
operations.

The model does not emit raw file diffs. It emits operations in a constrained
DSL — `MOVE`, `RENAME`, `DELETE`, `EXTRACT`, `INLINE`, `MERGE`, `SPLIT`. A local
runtime translates each operation into syntactically-valid file edits using a
real refactoring library. Edits land directly on the working branch (no safety
gate; no preview UI). The file watcher picks up the change and emits new history
rows tagged `source: 'agent'`. The graph re-renders. The loop closes.

The `source: 'agent'` tag breaks runaway feedback — the intent extractor filters
agent-authored rows out of its input, so the AI's edits are not interpreted as
new user intent.

A `view_mode` toggle (`explore` vs `influence`) gates the runner. Intents are
always extracted but only forwarded to the model in `influence` mode. Default
is `explore`.

---

## Open problems

Documented here because the ideas are valuable and easy to lose.

### Editing during runtime playback

When the user edits a value or a node during replay (or live execution), three
distinct intents are conflated by the same gesture:

1. **"What if this value were different?"** (curiosity) — fork the timeline,
   re-execute the new branch, show both side-by-side.
2. **"This value is wrong, fix it and continue."** (debugging) — pin the edited
   value, resume execution from the current `t` using the pinned value.
3. **"This source code should be different forever."** (real edit) — emit
   structural changes as history rows; in-flight runtime descendants either
   continue with the snapshot of the old structure or get cancelled and re-run.

The hard part is not implementing these — it is the UI distinguishing them from
a single gesture. Probably modifier keys (plain / alt / shift) or a context menu
post-edit. Both are bad in different ways.

The substrate that all three need: **causal cone visualization**. Hovering a
runtime node highlights every node that descended from it (forward cone) and
every node that contributed to it (backward cone). No edit required — just
visibility into causality. Build this first; the edit semantics layer on top.

The cone is bounded by practicality. The full causal cone of even a small value
can be enormous (a `Date.now()` at boot influences the entire program). Real
visualizations need cutoffs: first N descendants by recency, by edge weight, or
within the current screen fractal layer.

### Meta-rules

If rules are nodes and nodes have positions, then rules can be visualized,
dragged, and edited. A rule that fires on configurations of other rules is a
meta-rule — a refactoring of the type system, expressed in the same medium as
the type system. v1 does not need a UI for this. The schema must permit it.

### Imperative code

The model fits dataflow, functional, and message-passing patterns natively.
Tight imperative loops, mutable shared state, and prototype chain walks have no
clean "value flows along edge" story. They will appear denser in the hypergraph
than in source code.

This is a constraint, not a defeat. Code that does not visualize well is often
code that is hard to reason about anyway. If the hypergraph view makes 60% of
code dramatically more legible and is honest that the other 40% is best read as
source, that is a massive win. The mistake would be insisting on full coverage.

### How to bootstrap a rule pack

A rule pack is data, not code, but writing one by hand is tedious. The first JS
rule pack will probably be hand-authored from a small set of primitives (call,
parameter-bind, return, literal-instantiate, branch, loop, closure-capture).
Higher-level patterns (async/await, generators, classes, modules) compose from
the primitives. The bootstrap question is how much of this can be derived from
ASTs automatically vs. how much needs human judgment about what's "really" going
on. Probably tiered: derive the obvious cases, hand-author the patterns that
matter.
