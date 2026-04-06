// ── User-authored distance edges (Plan 2 Option E) ───────────────────────
//
// An edge collection specialized for type='distance' edges, keyed by
// canonical unordered {source,target} pair and keeping only the most-recent
// entry per pair. GraphPhysics reads the weights as spring rest-lengths.
//
// This IS the storage for distance edges. Data flows in and out as Edge
// domain objects:
//
//     transport (CSV/WS/SSE) ──► Edge ──► applyEdge ──► internal store
//                                                              │
//                        Edge ◄── forEachEdge(cb) ◄─────────────┘
//                         │
//                         └──► transport (CSV append / WS / DB sync)
//
// The callback surfaces (source, target, weight, t) — everything needed to
// reconstitute the Edge object on the way back out for persistence. The
// module knows nothing about CSV, WebSockets, or any transport; callers
// perform that conversion at the boundary.
//
// Edge shape:
//   { source: string, target: string, type: string, weight: number, t: number }
//
// - source/target are node ids.
// - type must be 'distance' for this module to accept the edge.
// - weight is the rest-length (euclidean distance at the moment of capture).
// - t is the capture timestamp; older entries are rejected in favor of newer.
//
// Public API:
//   applyEdge(edge)       → bool   stored if newest of its unordered pair
//   applyEdges(edges)     → number count of edges stored
//   forEachEdge(cb)       cb(source, target, weight, t) — zero-allocation
//   edgeCount()           → number
//   clear()               reset (tests)
(function (root) {
  'use strict';

  // Internal storage — NOT exposed. Consumers iterate via forEachEdge.
  const _store = new Map(); // pairKey → { w, t }

  function _pairKey(a, b) {
    return a < b ? a + '\x00' + b : b + '\x00' + a;
  }

  function applyEdge(edge) {
    if (!edge || edge.type !== 'distance') return false;
    const s = edge.source;
    const t = edge.target;
    if (!s || !t || s === t) return false;
    const w = Number(edge.weight);
    const ts = Number(edge.t);
    if (!isFinite(w) || w < 0) return false;
    if (!isFinite(ts)) return false;
    const key = _pairKey(s, t);
    const prev = _store.get(key);
    if (prev && prev.t >= ts) return false;
    _store.set(key, { w, t: ts });
    return true;
  }

  function applyEdges(edges) {
    if (!edges) return 0;
    let n = 0;
    for (const e of edges) if (applyEdge(e)) n++;
    return n;
  }

  // Invokes cb(source, target, weight, t) for each stored edge. No per-
  // iteration allocation — safe from 60 Hz physics loops. The timestamp
  // is passed through so callers that persist the store (CSV write-back,
  // DB sync) can reconstitute the original Edge objects.
  function forEachEdge(cb) {
    for (const [key, entry] of _store) {
      const sep = key.indexOf('\x00');
      cb(key.slice(0, sep), key.slice(sep + 1), entry.w, entry.t);
    }
  }

  function edgeCount() { return _store.size; }
  function clear() { _store.clear(); }

  const api = { applyEdge, applyEdges, forEachEdge, edgeCount, clear };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.userDistancesModule = api;
})(typeof window !== 'undefined' ? window : null);
