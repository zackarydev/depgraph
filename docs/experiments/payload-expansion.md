# Payload Expansion — Experiment Notes

**Branch:** `review2` (to be committed to a parking branch before main-line revert)
**Status:** Reverted. Too slow in the live UI feedback loop. Worth preserving as a branch — migrated history is nostalgic, and some emergent behavior is genuinely interesting.
**Date:** 2026-04-17

## How we got here

While watching `runtime/history.csv` scroll past, you noticed that x/y position values were sitting as plain numbers inside a JSON `payload` column — interesting data, but fundamentally *second-class*. Two intuitions followed:

1. **"x/y should have their moment too, their HLC."** Position writes deserve a first-class time coordinate, not a timestamp implicit in the row that happened to carry them.
2. **"Why is there a payload with the node definition?"** If the hypergraph's thesis is "nodes and edges are the only primitives," then a JSON pocket bundled onto every row is a carve-out — a bag of opaque information the graph can't reason about. That carve-out is why the system had started to feel stuck: downstream code was destructuring `row.payload.foo` ad-hoc in four or five places ([src/main.js:311](src/main.js#L311), [src/main.js:891-905](src/main.js#L891-L905), [src/core/state.js:76-90](src/core/state.js#L76-L90), readers in gather / click / reset).

You were OK with the size explosion the fix would cause. You wanted to see how the system handled it.

## Decisions taken (four clarifying questions)

1. **x/y moment shape.** Chose property-edges + HLC moment over any flatter encoding: each position write becomes a `moment:pos:<hlc>` node that owns `prop:x`/`prop:y`/`prop:subject` edges.
2. **Emitter scope.** Browser-originated rows only. Codegen (codemap/ast/repo-scanner/handlers) stays on the old payload shape for this pass; reader dual-mode on that input.
3. **Existing history.** Do not discard — "I actually kind of like it like this. It's nostalgic now." The run-on historical session is worth something. Migrate it as a hypergraph segment rather than wipe it.
4. **HLC for non-position rows.** Orthogonal. Only positions got HLC in this pass; `row.t` stayed ms for everything else.

Mid-planning, you shared a thermal-dissipation / burst-coalescer conversation with another agent. That's the natural counterpart to this change — the coalescer averages out short-burst edges between the same pair of nodes and would keep post-expansion history.csv from growing uncomfortably. We explicitly deferred it ("ship expansion now, coalescer separate") so this experiment wouldn't balloon.

## What was built

- **`src/data/payload-expand.js`** (new, shared helper). `expandPayload({ subjectId, payload, hlc })` returns an array of partial rows. Value nodes land under a `value:<key>:<canonical>` id (3-decimal quantized for floats). Property edges land under `prop:<subject>:<key>`. Author becomes `authored-by` → singleton `user` agent node. Producer becomes `produced-by` → singleton agent. Position (x+y together) is special-cased into a `moment:pos:<hlc>` node with `prop:subject`/`prop:x`/`prop:y`/`authored-by` edges.
- **`agentSeedRows()`** emits singletons for `user`, `codemap`, `ast`, `repo-scanner`, `system`, `migrate` so every authored-by / produced-by edge has a real target.
- **CSV schema** dropped column 11 (`payload`). Reader of legacy 11-col files silently ignores the extra column. Header: `t,type,op,id,kind,source,target,layer,weight,label`.
- **State.js** lost its payload-merge paths; stretch/directed moved to a prop-edge mirror (EDGE add with `layer=prop:stretch` reads the `value:stretch:<n>` target label and mirrors the number back onto the source edge's `.stretch`).
- **appendRow** in main.js grew a recursive expansion step: any `_payload` on an inbound row is stripped, expanded via the helper, and the expansion rows are recursively appended (base case is that expansion rows carry no `_payload`). A `_userAuthored` flag threads through so the mirror-to-server side-effect still fires once per logical user action.
- **Readers rewired.** Position restore on rebuild traverses the latest position-moment per subject and reads its prop:x/prop:y targets. Author-routing checks for an outgoing `authored-by` edge → `user` instead of `row.payload.author`.
- **Layer registration.** The six new synthetic layers (`authored-by`, `produced-by`, `prop:subject`, `prop:x`, `prop:y`, `prop:stretch`) are registered with `visible: false` to keep the render uncluttered.
- **`migrate-history.mjs`** (throwaway, repo root). One-shot converter that re-emits 15099 legacy rows as 60217 new rows. Uses a dedicated HLC with producerId `migrate`. Successfully ran; output at `runtime/history.migrated.csv`.

## What we observed — the interesting part

Live in the browser, the feedback loop was too slow. Every drag produced ~8 rows; every cluster-drag with N members produced ~10·N rows; every click produced ~8 rows; each of those reached the server, echoed back over SSE, re-applied to state, triggered rederive and descent. The CSV grew from 15k rows to 60k in the migration alone, and the live session pushed it to ~60.6k within minutes of interaction.

But the row content itself is where it got *strange*. Look at the tail of the live `runtime/history.csv`:

```
60506  NODE,update,value:endLine:201.000,…
60507  NODE,add,moment:pos:1776473054045:ui:0,moment,…
60508  EDGE,add,prop:…:subject,,moment:pos:…,value:endLine:201.000,prop:subject,1,
```

The **subject of a position-moment is the scalar number 201**. A value node — the literal `201.000` shared by every AST node whose endLine is 201 — got picked up by cluster physics and dragged. Its position was written back into history as a position-moment whose `prop:subject` points at the value node.

Same pattern:
- `value:line:221.000` was dragged (line 60518)
- `value:endLine:237.000` dragged (line 60530)
- `value:path:test/phase5-render.test.mjs` dragged (line 60588)
- `value:lines:652.000` dragged (line 60600)

The hypergraph is *correctly* telling you that every AST node whose endLine is 201 shares an identity through a single value node — so when cluster-drag moves "everything in this cluster," the shared value node rides along too, and physics then has to reconcile dozens of edges pulling on one gravitational singleton. Shared value nodes become black holes: many owners, one position, unresolvable tension.

This is not a bug in the expansion. It's the first honest consequence of taking the thesis seriously: "201 is a thing in the graph." Once 201 is a thing, it has a position. Once it has a position, physics moves it. Once physics moves it, everyone pointing at 201 feels the force.

Two readings:
- **Feature.** This is exactly the emergence we're after — structural identity across AST nodes becomes visible as gravity. A coalescer plus a "value nodes participate in physics, but weakly / don't get their own moments" guardrail could turn this into a useful visual.
- **Premature.** The UI wasn't designed for it. Dragging a cluster now drags every shared scalar used by every member, producing a physics regime that wasn't asked for and that swamps the feedback loop.

Also visible: `value:cluster:cluster:cluster:file:src/data/history.js` (note the triple prefix). The cluster-drag emitter stringifies cluster ids that already carry `cluster:`, so each round-trip through the payload re-prefixes. Harmless, cosmetic, worth noting.

## Why we're reverting

The bottleneck is the **UI feedback loop**: live drag/click/cluster-drag each produce a fan-out burst that the SSE → parse → rederive → descent pipeline can't keep up with at 60fps. The data shape is defensible; the write cadence is not. Without a coalescer or a scope reduction on what fans out live, the system is unusable in the browser.

## Paths forward

You raised this yourself: *"Perhaps we only remove the feedback loop with the UI."* That's the most promising narrow cut. A few concrete variants:

1. **Keep expansion at rest, not in flight.** Interactive drags keep writing a lean `NODE,update` with x/y as before. A background pass (on history tail, on idle, or as part of codegen) expands them into position-moments later. The on-disk record ends up in the new shape; the hot loop stays cheap.
2. **Expand everything except positions.** Clicks, cluster events, gather moments expand into prop-edges; positions stay as bare updates. Positions are the highest-frequency write by far (every frame of a drag), so removing them from the fan-out path reclaims most of the perf.
3. **Ship the coalescer first, then re-enable.** The thermal-dissipation pass already sketched in the shared conversation is the right architectural partner: let bursts accumulate, average them out on a window, keep endpoints + a count. Positions on a single drag collapse to one moment, not forty. With that in place, try live expansion again.
4. **Guardrail value-node physics.** Independent of the above: value nodes should probably be *layout-passive* — they exist in the graph and edges can traverse them, but they don't receive forces and don't get their own positions. That kills the "201 becomes a black hole" regime while keeping the structural identity the expansion was supposed to reveal.

My intuition is **(2) + (4)** as a conservative next attempt: non-position expansion immediately, positions stay bare, value nodes don't move. Then layer in the coalescer and re-enable position expansion when it's ready.

## What to preserve from this branch

- `src/data/payload-expand.js` — the helper itself is the actual asset. Any future version of this will call it.
- `migrate-history.mjs` + `runtime/history.migrated.csv` — the migrated nostalgic history as a hypergraph segment. Worth committing before the migrator is deleted.
- The agent-singleton concept (`user`, `codemap`, `ast`, `repo-scanner`, `system`). Even if we don't expand payloads, having these as real nodes is cheap and gives `authored-by`/`produced-by` edges a place to land whenever we do reach for them.
- The position-moment shape (`moment:pos:<hlc>` + `prop:subject`/`prop:x`/`prop:y`). This is the right representation; we just can't afford it per-frame.
- These notes.

## What the revert should touch

Files changed in this experiment, all to be reverted on main:
- `src/data/csv.js` (schema)
- `src/core/state.js` (payload-merge removal, prop:stretch mirror)
- `src/core/types.js` (HistoryRow JSDoc)
- `src/main.js` (appendRow recursion, rebuild position-moment reader, agent seeding, emission sites)
- `src/rules/click-events.js` (`payload:` → `_payload:`)
- `src/rules/cluster-rules.js` (stretch via prop-edge)
- `src/rules/gather.js` (reader)
- `src/interact/drag.js` (`payload:` → `_payload:`)
- `src/interact/reset.js` (`payload:` → `_payload:`)
- `depgraph-server.mjs` (arity check)

Preserve on the parking branch. Delete `migrate-history.mjs` after the migrated CSV is captured.
