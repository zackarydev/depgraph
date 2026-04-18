# Plan: History Dissipation — Coalescer & Walker

## The problem

`runtime/history.csv` is append-only by design (SPEC §4). That is
load-bearing — replay, branching, time-travel all depend on it. But append-only
has an energy problem: every mouse drag writes dozens of near-identical
`spatial:*` edges in a short burst, every click emits a transient `event:click`
node, and the file grows monotonically. At 14,865 rows / 2.7MB on a
single-developer repo the scan is still cheap. At the VISION.md scale ("all
repos, all interactions, all tools, continuously") it is fatal.

Example burst, all from one drag (see `runtime/history.csv` around row
14754): eleven `spatial:file:QUANTUM_PARALLEL.md->...` edges within a
single `drag` gesture, each with marginally different weights (0.484, 0.483,
0.482, ...) and distances (107, 107, 107, 124, 124, ...). The information
content of rows 2-11 is effectively zero once row 1 and row 11 are known.

## The framing: dissipation

Treat the history as a physical system. Recent events carry high-frequency
detail (the user is still interacting with them; the UI may need per-frame
fidelity). Old events are cold — nobody will scrub to 1776399928540.123 to
see which specific frame of a drag produced that weight. **Over time, high
frequencies in the log should dissipate into low frequencies**, the way
thermal fluctuations average out in a cooling system.

Two independent mechanisms, composable:

1. **Coalescer** — chronological, pass-based, cheap. Scans the log in order
   and merges burst windows. Deterministic, easy to reason about, easy to
   invert (if you kept the coalesced count, you can recover cardinality).
2. **Walker** — graph-structural, autonomous, adaptive. Navigates the
   hypergraph following edges, detects locally-noisy neighborhoods, and
   dissipates them. Goes where the entropy is, not where time is.

Both obey two hard rules:
- **Never modify rows older than `AGE_FLOOR`** (default: 1 minute). The
  present is inviolable; only the past is compressible.
- **Append, don't edit.** Compaction emits new rows (`op=compact` or a
  tombstone-plus-summary pair). The raw log is never rewritten in place.
  CSV export/import remains bit-exact for any range not yet compacted.

---

## Part 1: The Coalescer

### Shape

A single pass over the log, identifying burst windows and replacing each
with one summary row. Runs on load (cheap, idempotent), on demand, or on a
timer for long-lived sessions.

### Burst definition

A *burst* is a maximal run of rows satisfying all of:
- same `type`, `op`, `source`, `target`, `layer` (edges) or same `id`
  (node updates)
- consecutive in time (no intervening row of a different signature)
- span ≤ `BURST_WINDOW_MS` (default: 2000ms)
- count ≥ `BURST_MIN` (default: 4)
- all rows older than `AGE_FLOOR` (default: 60_000ms from now)

Mouse-move / drag / pointer-frame events get a more aggressive window
(default: 10_000ms, min: 2). Structural `NODE add` / `EDGE add` of new ids
never coalesce (each one carries unique information).

### Pseudocode

```
function coalesce(rows, now):
    out = []
    i = 0
    while i < len(rows):
        window = collect_burst(rows, i, now)
        if len(window) >= BURST_MIN and is_coalescable(window):
            out.append(summarize(window))
            i += len(window)
        else:
            out.append(rows[i])
            i += 1
    return out

function collect_burst(rows, start, now):
    head = rows[start]
    if head.t > now - AGE_FLOOR:
        return [head]                     # too recent, hands off
    window = [head]
    j = start + 1
    while j < len(rows):
        r = rows[j]
        if not same_signature(r, head):       break
        if r.t - head.t > burst_window(head): break
        window.append(r)
        j += 1
    return window

function summarize(window):
    first = window[0]
    last  = window[-1]
    return Row(
        t       = first.t,                    # preserve burst start
        type    = first.type,
        op      = first.op,
        id      = first.id,
        source  = first.source,
        target  = first.target,
        layer   = first.layer,
        weight  = mean(r.weight for r in window),
        label   = first.label,
        payload = {
            ...first.payload,
            coalesced: {
                count:    len(window),
                t_end:    last.t,
                w_first:  first.weight,
                w_last:   last.weight,
                w_min:    min(r.weight for r in window),
                w_max:    max(r.weight for r in window),
            }
        }
    )
```

### What gets aggressively coalesced

| Signature                              | Window  | Min | Strategy          |
|----------------------------------------|---------|-----|-------------------|
| `EDGE add` spatial + drag-spatial      | 10s     | 2   | mean weight       |
| `NODE update` drag (per-node pos)      | 10s     | 3   | keep first + last |
| `EDGE add` click (transient)           | 5s      | 5   | drop all but one  |
| pointer-move / hover (Tier 0 ephemeral)| N/A     | —   | never persist     |
| `NODE add` / `EDGE add` structural     | —       | —   | never coalesce    |

### Why this is reversible-ish

Keeping `coalesced.count` and `coalesced.t_end` means you can later ask
"how many drag frames did row 14754 originally represent?" and get `11`.
You cannot recover the *exact intermediate weights* — that information is
genuinely discarded — but you can recover cardinality, bounds, and
endpoints. For mouse-drag bursts, this is more than enough.

---

## Part 2: The Walker

### Shape

An autonomous agent that walks the hypergraph like a random-walker with
thermal bias. At each node it asks: *"am I surrounded by redundant,
low-information edges to my neighbors?"* If yes, dissipate. If no, step to
a neighbor and keep walking. Runs in the background (Web Worker when we
have workers per Phase 5 of BUILD_PROMPT_HISTORYV2).

Unlike the coalescer, the walker navigates **structure**, not time. Two
rows separated by 10,000 other rows can still be the "same burst" if they
share a spatial relationship — the walker finds that. The coalescer cannot.

### Walk dynamics

- **Start**: biased toward high-degree nodes (where entropy accumulates),
  picked with probability proportional to `degree(n)^α` (α ≈ 1.5).
- **Step**: follow an outgoing edge with probability proportional to
  `weight`, with a small reset probability (teleport to a new high-degree
  seed) to avoid trapping.
- **Budget**: each walk gets `MAX_STEPS` (default: 50) and `MAX_DISSIPATIONS`
  (default: 5). When either is exhausted, the walk ends and commits.

### Local dissipation check

At each node `n`, the walker looks at out-edges grouped by `(layer, target)`.
A group is a *dissipation candidate* if:
- |group| ≥ `LOCAL_BURST_MIN` (default: 3)
- all rows in group older than `AGE_FLOOR`
- all rows carry the "burst-prone" marker (drag-spatial, click, pointer, ...)
- weight variance within the group < `FLATTEN_THRESHOLD` (default: 0.05)

The variance check is the walker's key move: if eleven edges to the same
neighbor all have weight 0.48 ± 0.01, they encode the same relationship
eleven times. Collapse them. If they span 0.1 to 0.9, they encode
*motion* and must be preserved (or at least summarized with first/last).

### Pseudocode

```
function walker_tick(graph, history, now):
    node = sample_high_degree(graph)
    steps = 0
    dissipated = 0
    visited = set()
    while steps < MAX_STEPS and dissipated < MAX_DISSIPATIONS:
        if node in visited: break         # simple cycle guard
        visited.add(node)
        for group in neighbor_groups(node):
            if should_dissipate(group, now):
                emit_dissipation(history, group)
                dissipated += 1
        next = sample_next(node, graph)   # weighted, with reset
        if next is None: break
        node = next
        steps += 1

function neighbor_groups(node):
    # group out-edges by (layer, target), include row references back to history
    groups = {}
    for e in node.out_edges:
        key = (e.layer, e.target)
        groups.setdefault(key, []).append(e)
    return groups.values()

function should_dissipate(group, now):
    if len(group) < LOCAL_BURST_MIN:                       return False
    if any(e.t > now - AGE_FLOOR for e in group):          return False
    if not all(burst_prone(e) for e in group):             return False
    weights = [e.weight for e in group]
    if variance(weights) > FLATTEN_THRESHOLD:              return False
    return True

function emit_dissipation(history, group):
    # one summary row in; tombstone rows out (append-only)
    summary = summarize(group)              # same shape as coalescer
    summary.op = 'compact'
    history.append(summary)
    for e in group:
        history.append(tombstone(e, superseded_by=summary.id))
```

### What "tombstone" means here

Because the log is append-only, the walker cannot remove rows. Instead it
appends a `TOMBSTONE` row that says "row with id X at time T is superseded
by the compact row at time T'". The loader, on replay, skips any row that
has a later tombstone for its (id, t) pair. This preserves:
- bit-exact CSV export of any pre-compaction range (tombstones are just
  metadata rows; you can filter them out)
- full reversibility — removing the tombstones un-compacts the history
- linear append-only semantics

### Scheduling

Walkers are cheap — a single tick is O(MAX_STEPS × avg_degree). Run:
- **on idle**: when the main thread has been quiet for >2s, tick once.
- **on growth**: every N new rows appended (default N=1000), tick once.
- **on demand**: user action "dissipate old history".

Hundreds of ticks per hour is fine. Thousands is fine. The compression
ratio compounds — the second pass finds bursts the first pass missed
because the first pass's summary rows are themselves now groupable.

---

## Part 3: Composition

The two mechanisms are designed to work together, not in competition:

| Phase         | Mechanism   | When                          | Strengths                    |
|---------------|-------------|-------------------------------|------------------------------|
| Load          | Coalescer   | once, on history read         | fast, predictable, global    |
| Streaming     | (neither)   | live events, age < AGE_FLOOR  | untouched, high fidelity     |
| Background    | Walker      | idle + growth triggers        | structural, adaptive         |
| User request  | Both        | "compact history" button      | explicit, blocking           |

The coalescer is the floor — it handles the 80% case (consecutive bursts of
identical signature) deterministically. The walker handles what's left:
bursts separated by intervening rows, high-entropy neighborhoods, and
second-order compression of already-summarized rows.

---

## Part 4: Open questions

1. **Where does the compaction metadata live?** Option A: inline in
   `payload.coalesced`. Option B: a sidecar `runtime/history.compact.csv`
   that parallel-tracks the main log. Option A is simpler; Option B keeps
   raw history pristine. Leaning A.

2. **Do tombstones need their own event type?** `TOMBSTONE` is a new
   top-level `type`, which the schema freeze (history-schema.md) warns
   against. Alternative: reuse `NODE update` with a special payload
   marker. Less clean, but no schema bump.

3. **Re-ordering interaction.** If the walker fires while the user is
   scrubbing through time-travel, does the compacted range change under
   them? Probably need a "freeze dissipation during active scrub" lock.

4. **Multi-node drags.** When the user drags a cluster, every child node
   emits update rows in lockstep. Should the walker detect the *cluster*
   as the burst-group, not the individual nodes? This is an argument for
   a dedicated cluster-aware pass.

5. **Mouse-move tier.** BUILD_PROMPT_HISTORYV2 Phase 1 already proposes
   putting pointer-move / hover in a Tier 0 ring buffer that never hits
   the log. If that ships, the most aggressive dissipation target
   disappears — the coalescer/walker become about drag-spatial bursts and
   click events, which are already lower-frequency. This plan is
   complementary to that one, not a replacement.

---

## Migration

Independently shippable, in order:

1. **Coalescer, offline only.** Script that reads `runtime/history.csv`,
   writes `runtime/history.coalesced.csv`, and diffs row counts. No
   runtime integration. Verify round-trip sanity on the current log.
2. **Coalescer, on load.** `src/data/history.js` runs coalesce() after
   parse. Gated behind a flag. Measure boot time delta.
3. **Tombstone semantics.** Define the skip-rule in the replay path.
   Make sure CSV export filters tombstones by default but has a
   `--raw` mode.
4. **Walker, offline only.** Same shape as step 1 — standalone script,
   writes a separate output, diffable.
5. **Walker, background tick.** Add to the animation/idle loop. Gated
   behind a flag. No worker yet — run on main thread with small budgets.
6. **Walker, worker.** Moves to a Web Worker (aligns with Phase 5 of
   BUILD_PROMPT_HISTORYV2). Shares history via SharedArrayBuffer once
   binary log exists.

Each step is reversible (delete the output, restore from raw CSV) and
each step is a win on its own (step 2 alone likely cuts the file by
40-60% given the current drag-burst density).
