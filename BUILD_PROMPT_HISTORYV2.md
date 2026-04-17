# Plan: Event Runtime — Beyond CSV

## Context

Depgraph's architecture commits to "everything is a row in history.csv" (SPEC commitment #2). This is load-bearing: time-travel, branching, replay, and streaming all work because the event log IS the truth. But the current implementation — a text CSV parsed line-by-line, stored in localStorage, polled at 500ms — is already straining at 3000 nodes / 4300 edges / 5700 rows / 1MB. The ambition (VISION.md) is orders of magnitude larger: all repos, all interactions, all tools, continuous updates, infinite scale.

The user wants to:
1. Encode **all UI state** (hover, selection, collapse, camera) as events in the log
2. Move to a **binary runtime** that can handle high-frequency writes
3. Scale to **100k+ nodes** without the rendering/derivation pipeline falling over
4. Add **verification** (Merkle trees, hash chains) for integrity
5. Keep the append-only, event-sourced architecture — this is non-negotiable

This plan is the bridge from "CSV that works for demos" to "runtime harness that can host the vision."

---

## The Core Tension

The CSV is simultaneously the best and worst thing about depgraph.

**Best**: it's human-readable, git-diffable, trivially debuggable, self-documenting. You can `tail -f history.csv` and watch the graph being built. You can edit it by hand. You can `grep` it. This is enormously valuable for a system whose architecture is still being discovered.

**Worst**: text parsing is O(characters), not O(events). JSON payloads inside CSV cells means double-parsing. No random access. No indexes. localStorage caps at 5-10MB. The 500ms poll loop adds latency. Every `toCSV()` call serializes the entire history.

The plan preserves what's good (linear, append-only, inspectable, exportable) while replacing what's bad (text parsing, no indexes, no tiering, no binary efficiency).

---

## Phase 1: Event Taxonomy

### The Problem
Right now there are 2 event types (`NODE`, `EDGE`) with 3 ops (`add`, `update`, `remove`). UI state is scattered across ~10 `let` bindings in main.js (selection, dragState, traceState, gatherState, resetState, timeTravelState, keyState, etc). None of this state survives a page reload. None of it is replayable.

### The Design

Three frequency tiers, each with different storage and propagation rules:

```
TIER 0 — EPHEMERAL (ring buffer, never persisted)
  hover, unhover, pointer-move, camera-move, drag-frame
  Rate: 30-200 events/sec
  Lifetime: seconds (overwritten as ring buffer wraps)
  Purpose: the renderer reads these to decide visual state

TIER 1 — SESSION (binary log, compactable)  
  select, deselect, collapse, expand, pin, unpin,
  drag-end, arrange-save, context-switch, search-query
  Rate: 0.1-5 events/sec
  Lifetime: session to permanent (compacted to snapshots)
  Purpose: UI state that should survive reload and be replayable

TIER 2 — STRUCTURAL (binary log, permanent)
  NODE add/update/remove, EDGE add/update/remove,
  system connect/disconnect, checkpoint, compact
  Rate: 0.01-100 events/sec (bursty on scan, slow otherwise)
  Lifetime: permanent (archived, never deleted)
  Purpose: the graph itself
```

### The Critical Rule

**Ephemeral events do NOT trigger derivation.** They are read-only by the renderer. This prevents the circular dependency: hover -> event -> rederive -> rerender -> new hover target -> loop. Only Tier 1 and Tier 2 events enter the derivation pipeline.

Exception: a **promotion** mechanism allows ephemeral events to become session events after a threshold (e.g., hover > 2s -> pin). Promotion runs on a debounced timer (100-500ms), not per-event.

### What This Enables

The hypergraph becomes self-aware of its own UI state. "What is selected?" is answered by querying recent `select` events. "Where was the camera?" is answered by the ring buffer. A future AI agent can read the event log and understand not just the code structure but how the human explored it — what they looked at, what they collapsed, what they dragged together. The interaction IS data.

### Files to Change
- `src/core/types.js` — add EventType enum, tier classification
- `src/core/state.js` — add `uiState` object alongside nodes/edges
- `src/main.js` — replace the ~10 `let` bindings with uiState reads/writes

---

## Phase 2: Decouple Rendering from Mutations

### The Problem (Ship This First)

Every `row-appended` bus event triggers `fullRender()` — which rebuilds all SVG elements. When the watcher generates 50 events in a burst (file save -> scan -> diff), that's 50 full renders in rapid succession. This is the single biggest performance bottleneck and it's fixable today with zero architectural changes.

### The Fix

Replace per-event rendering with a dirty flag checked once per animation frame:

```
bus.on('row-appended') -> set dirtyGraph = true
animation loop:
  if (dirtyGraph) { fullRender(); dirtyGraph = false; }
  if (descentBurstFrames > 0) { descentStep(); renderPositionsOnly(); }
```

This collapses N mutations into 1 render per frame. At 60fps, even 1000 events/sec get batched into 16-17 renders/sec.

### Files to Change
- `src/main.js` — the `bus.on('row-appended')` handler and the animation loop

---

## Phase 3: Binary Event Log

### Format

Replace CSV with a binary append-only log. Design goals: mmap-friendly, O(1) append, O(log N) random access.

```
Record layout (variable length):
  [4B length] [8B seq] [8B timestamp] [1B type] [1B op] [2B flags]
  [2B idLen] [idLen bytes id] [remaining: MessagePack payload]

Page index (appended every 1000 records):
  Array of { seq: uint64, byteOffset: uint64 }
  Enables binary search for time-travel
```

### Why MessagePack
- Schema-less like JSON (matches current flexibility)
- 30-50% smaller than JSON
- 3-5x faster to parse
- 12KB gzipped as an npm dep
- Both Node.js and browser support

### Size Estimates
Current: 5700 rows * ~192 bytes avg = 1.07 MB (CSV)
Binary: 5700 rows * ~96 bytes avg = ~548 KB (roughly 50% of CSV)

At 100k-node scale (estimated 500k structural + 200k UI events):
- ~60 MB total durable log. Fits in a single mmap. Fine.

At 1M-node scale (the "everything" ambition):
- ~600 MB. Still fits in mmap on any modern machine. Segments needed beyond this.

### The Escape Hatch
**CSV import/export must always work.** The binary format is the runtime representation. CSV is the interchange format, the debugging tool, the git-friendly artifact. `binary-log.js` implements `fromCSV()` and `toCSV()`. If the binary code has a bug, dump to CSV, delete the binary, re-import. The existing `data/csv.js` is never removed.

### Files to Create/Change
- New: `src/data/binary-log.js` — format read/write/append
- New: `src/data/idb-store.js` — IndexedDB wrapper (replaces localStorage)
- Change: `src/data/history.js` — binary backend option alongside CSV
- Change: `src/stream/local-persistence.js` — IndexedDB instead of localStorage

---

## Phase 4: Tiered Storage

### Hot Tier: Ring Buffer (ArrayBuffer, main thread)

```
RingBuffer {
  buffer: ArrayBuffer(65536)  // 64KB fixed, ~1000 pointer events, ~16s at 60fps
  writeHead: uint32
  readHead: uint32
  
  append(event): void         // O(1), overwrites oldest on full
  latest(entityId): Event     // scan backward, typically <10 entries
  drain(predicate): Event[]   // for promotion to warm tier
}
```

Typed ArrayBuffer, no GC pressure, no object allocation on write. This is the "close to hardware" part the user mentioned — raw bytes, fixed layout, no abstraction.

### Warm Tier: Binary Log (Recent events, mmap on server, IndexedDB in browser)

The last N structural + session events since the most recent snapshot. Target: keep under 10MB. At ~96 bytes/event, that's ~100k events = weeks of active work for a solo developer.

### Cold Tier: Compressed Archive

Everything before the last compaction point. Gzipped binary segments in `runtime/archive/` (directory already exists). In the browser: IndexedDB blobs loaded only on demand (time-traveling past warm boundary).

### Materialized Views (Fast Boot)

Instead of replaying all rows on load:
1. Load latest snapshot from IndexedDB (the graph state at seq=N)
2. Replay only warm-tier events from N+1 to head
3. Boot time: ~10ms vs current full-CSV-replay

### Compaction

Compaction creates a new warm segment:
1. Snapshot materialized state at seq=N
2. Write snapshot as SYSTEM checkpoint event
3. Append events with seq > N
4. Move old segment to cold tier (compress)

Trigger: warm tier > 100MB, or explicit user action. For one repo, this is months of history.

---

## Phase 5: Compute Off Main Thread

### Layout Worker + SharedArrayBuffer

Move gradient descent + quadtree to a Web Worker. Positions shared via SharedArrayBuffer (zero-copy):

```
positionBuffer = new SharedArrayBuffer(MAX_NODES * 16)  // 100k nodes = 1.6MB
Layout worker: writes [x, y] pairs + Atomics.store(frameSeq)
Renderer: reads [x, y] pairs when Atomics.load(frameSeq) changes
```

No postMessage, no copying, no serialization. True zero-copy.

**Requirement**: Server must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. One-line change to `depgraph-server.mjs`.

**Fallback**: If SharedArrayBuffer is unavailable, use `Transferable` ArrayBuffer ping-pong (ownership alternates between worker and main thread, one frame latency).

### Derivation Worker

Separate worker for derive pipeline. Receives graph mutations via postMessage, sends back updated clusters/affinities. Runs asynchronously — the renderer doesn't block on derivation.

### GPU Compute (Horizon — 50k+ nodes)

WebGPU compute shaders for N-body repulsion. CPU handles edge springs (sparse, irregular access patterns don't benefit from GPU parallelism). This is the 50k-100k node enabler but not needed until you're past the 10k mark.

### Files to Create/Change
- New: `src/layout/layout-worker.js` — worker entry point
- Change: `src/layout/positions.js` — back PositionMap with SharedArrayBuffer
- Change: `depgraph-server.mjs` — add COOP/COEP headers

---

## Phase 6: Rendering at Scale

### Canvas Hybrid (10k nodes)

Replace SVG nodes/edges with Canvas 2D. Keep SVG for hulls and labels (text rendering).

At 3000 nodes, SVG means 3000+ DOM elements with style computation, reflow, event listeners. Canvas is one element, one draw call per node. 10x-50x faster for nodes.

### Viewport Culling

`viewport.js` already has `queryVisible()` and LOD levels. But `legacyRenderFull()` ignores them and renders everything. Wire culling into the render loop:
1. Compute visible set via quadtree + camera bounds
2. Only draw visible nodes (+ 200px halo for smooth pan)
3. For 100k nodes showing ~500: 200x reduction in per-frame work

### LOD Levels (already defined in viewport.js)
- **dot** (< 8px screen radius): 1-2px point, no label
- **circle** (8-40px): filled circle + optional label
- **expanded** (80px+): full cluster with hull, internal edges

### WebGL (Horizon — 30k+ nodes)

Full WebGL2 or WebGPU rendering. SDF fonts for labels. Instanced rendering for nodes. Position buffer shared directly from layout worker's SharedArrayBuffer — no CPU readback needed.

### Files to Create/Change
- New: `src/render/canvas.js` — Canvas2D renderer
- Change: `src/render/legacy.js` — extract hull/label rendering for hybrid use
- Change: `index.html` — add `<canvas>` overlaid on SVG
- Feature flag: `renderMode: 'svg' | 'canvas' | 'webgl'`

---

## Phase 7: Verification and Integrity

### Hash Chains

Each event includes a `prevHash` field (4 bytes, truncated SHA-256 of previous event). Walking forward and checking hashes detects any retroactive modification.

4 bytes = 2^32 collision resistance. Sufficient for a local single-developer tool. The Merkle tree provides full cryptographic strength.

### Merkle Tree

Each page (1000 events) gets a SHA-256 hash. Pages organized into a binary Merkle tree. Enables:
- **Integrity check after crash**: rehash suspect pages, compare to tree
- **Tamper detection**: detect if a producer modified history
- **Efficient sync**: exchange root hashes, drill down to find divergent pages (future: multi-developer replication)

Cost: SHA-256 of ~96KB page = ~0.1ms. Tree update on append = O(log pages). Negligible.

### Files to Create
- New: `src/data/merkle.js` — tree construction, verification
- Change: `src/data/binary-log.js` — add prevHash to records, maintain tree on append

---

## Phase 8: What Can Go Wrong

### 8.1 The Feedback Loop
UI-state-as-events creates a potential infinite loop: event -> derive -> render -> new event. **Broken by design**: ephemeral events don't trigger derivation. Session events trigger derivation but are low-frequency (0.1-5/sec). The render loop is decoupled from the event loop (Phase 2).

### 8.2 Producer Bursts
The watcher scans a file and generates 50 events at once. Currently each triggers `fullRender()`. After Phase 2 (dirty flag batching), 50 events = 1 render. After Phase 5 (worker), derivation doesn't block rendering at all. Non-issue once Phase 2 ships.

### 8.3 Hot Tier Overflow
The 64KB ring buffer holds ~16 seconds of pointer events at 60fps. If promotion logic hasn't run by the time an event is overwritten, the promoted action is lost. **Fix**: promotion runs synchronously on every write (one comparison, nanoseconds) or on a 100ms drain timer.

### 8.4 The 10k-30k Performance Cliff
This is the most dangerous range. SVG is too slow, Canvas isn't wired up yet. Derivation is O(|E|) per dirty flush but incremental fix isn't in yet. **Priority**: Phase 2 (batching) + Phase 6 (canvas) + incremental derivation fix in derive.js must ship before scaling past 10k.

### 8.5 SharedArrayBuffer Restrictions
Requires COOP/COEP headers. If behind a reverse proxy that strips them, fall back to Transferable ArrayBuffer ping-pong. One frame latency penalty. The server is local, so this is unlikely to be an issue.

### 8.6 IndexedDB Reliability
Safari evicts after 7 days of inactivity. Firefox prompts above 50MB. **Mitigation**: server is authoritative. IndexedDB is a cache. On boot with empty IDB, request snapshot from server. Offline: start fresh with demo data (existing behavior).

### 8.7 Complexity Trap
A custom binary format + custom indexes + custom compaction + Merkle verification is a lot of surface area for one person. **Guardrail**: CSV export always works. If the binary code has a bug, dump to CSV, delete binary, re-import. Ship each phase independently. Don't build Phase 7 (Merkle) before Phase 3 (binary log) is battle-tested.

### 8.8 The "Non-Linear History" Question
The user mentioned non-linear history possibly being "encoded in the history.csv file directly." This is already partially true — branching exists in the history object (SPEC $10-11). But true DAG-structured history (multiple parents, merges) is a much harder problem. The binary log format supports it (sequence numbers don't require linearity), but the derivation pipeline assumes linear replay. **Recommendation**: keep linear replay as the default. DAG history is a Phase 9+ concern that requires CRDT-style merge semantics.

---

## Migration Order (What Ships When)

Each stage is independently shippable and testable:

| Stage | What | Risk | Deps | Effort |
|-------|------|------|------|--------|
| **1** | Batch rendering (dirty flag) | Low | None | 1 day |
| **2** | Event taxonomy + uiState object | Low | None | 2-3 days |
| **3** | Incremental derivation fix | Medium | None | 2-3 days |
| **4** | Layout worker + SharedArrayBuffer | Medium | COOP/COEP headers | 1 week |
| **5** | Canvas hybrid renderer | Medium | Stage 1 | 1 week |
| **6** | Binary log + IndexedDB | High | Stage 2 | 2 weeks |
| **7** | Ring buffer + ephemeral events | Medium | Stage 2, 6 | 1 week |
| **8** | Tiered storage + compaction | High | Stage 6 | 1-2 weeks |
| **9** | Merkle verification | Low | Stage 6 | 3-4 days |
| **10** | WebGL renderer | High | Stage 5 | 2-3 weeks |
| **11** | WebGPU compute | Very High | Stage 4, 10 | 3-4 weeks |

**Recommended first sprint**: Stages 1-3. Pure performance wins, no architectural risk, immediately testable. Gets you from "struggling at 3k nodes" to "comfortable at 10k nodes."

**Second sprint**: Stages 4-5. Workers + Canvas. Gets you to 30k nodes at 60fps.

**Third sprint**: Stages 6-8. Binary runtime. Gets you off CSV for the hot path. CSV remains as import/export/debug.

---

## Key Files

| File | Role in Migration |
|------|-------------------|
| `src/main.js` | Every phase touches this. Stage 1 starts here (batch rendering). |
| `src/data/derive.js` | Stage 3 (incremental fix). Current O(\|E\|) recompute is the scaling bottleneck. |
| `src/data/history.js` | Stage 6 (binary backend). Must preserve cursor/branch API. |
| `src/layout/gradient.js` | Stage 4 (worker boundary). Moves to layout-worker.js. |
| `src/render/legacy.js` | Stage 5 (canvas hybrid). Extract hull/label rendering. |
| `depgraph-server.mjs` | Stage 4 (COOP/COEP headers), Stage 6 (binary serving). |
| `src/data/csv.js` | Never removed. Becomes the escape hatch and interchange format. |

## Verification

After each stage:
- Load runtime/history.csv, verify identical graph rendering
- Run `npm test` — pre-existing failures only
- For performance stages: measure frame time with 10k synthetic nodes (generate with modified demo-history.js)
- For binary log: round-trip CSV -> binary -> CSV, diff should be empty
- For workers: verify layout convergence matches single-threaded result
