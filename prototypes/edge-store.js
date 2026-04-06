// ── Canonical hypergraph edge store ──────────────────────────────────────
//
// One store, all edges. No per-consumer shadow copies. Every module that
// reasons about edges — physics springs, cluster membership, zoom layers,
// user groupings, action log, arrangements — reads and writes here.
//
// An edge is the whole domain. Its shape:
//   { source, target, type, weight?, t, ...attrs }
//
// Identity (deduplication key) is determined per type. Two producers
// writing the same (type, identity) collide, and the configured merge
// strategy decides who wins.
//
// Identity classes:
//   'directed'   A→B keyed separately from B→A           (default)
//   'unordered'  A↔B keyed canonically, order-insensitive
//   'source'     at most one edge of this type per source
//   'unique'     no dedup; every assertion stored under a fresh key
//
// Types with no registered identity default to 'directed'. Register
// new types at runtime with registerIdentity(type, klass).
//
// Merge strategies live on the put() call itself:
//   put(edge)         always overwrite (replace)
//   putIfNewer(edge)  keep only the entry with the largest t
//
// Persistence: the store is the single serialization target. forEach /
// forEachByType yield the Edge objects that were stored, and a CSV/DB
// writer can round-trip the store by iterating and emitting rows.
(function (root) {
  'use strict';

  const IDENTITY = {
    // Symmetric / unordered
    distance: 'unordered',
    shared: 'unordered',
    sharedWrites: 'unordered',
    'user-group': 'unordered',
    // Directed
    calls: 'directed',
    calledBy: 'directed',
    writesTo: 'directed',
    uses: 'directed',
    memberOf: 'directed',
    param: 'directed',
    arg: 'directed',
    binds: 'directed',
    init: 'directed',
    key: 'directed',
    importance: 'directed',
    // Append-only
    ACTION: 'unique',
  };

  function registerIdentity(type, klass) { IDENTITY[type] = klass; }
  function identityOf(type) { return IDENTITY[type] || 'directed'; }

  let _uniqueCounter = 0;

  function identityKey(edge) {
    const klass = identityOf(edge.type);
    const s = edge.source, t = edge.target;
    switch (klass) {
      case 'unordered':
        return edge.type + '\x01' + (s < t ? s + '\x00' + t : t + '\x00' + s);
      case 'source':
        return edge.type + '\x01' + s;
      case 'unique':
        return edge.type + '\x01#' + (++_uniqueCounter);
      case 'directed':
      default:
        return edge.type + '\x01' + s + '\x00' + t;
    }
  }

  function _valid(e) {
    if (!e) return false;
    if (typeof e.type !== 'string' || !e.type) return false;
    if (!e.source || !e.target) return false;
    if (e.source === e.target) return false;
    return true;
  }

  function createEdgeStore() {
    const byId = new Map();    // identityKey → edge
    const byType = new Map();  // type → Set<identityKey>

    function _track(type, id) {
      let s = byType.get(type);
      if (!s) { s = new Set(); byType.set(type, s); }
      s.add(id);
    }
    function _untrack(type, id) {
      const s = byType.get(type);
      if (s) { s.delete(id); if (s.size === 0) byType.delete(type); }
    }

    function put(edge) {
      if (!_valid(edge)) return false;
      const id = identityKey(edge);
      byId.set(id, edge);
      _track(edge.type, id);
      return true;
    }

    function putIfNewer(edge) {
      if (!_valid(edge)) return false;
      const ts = Number(edge.t);
      if (!isFinite(ts)) return false;
      const id = identityKey(edge);
      const prev = byId.get(id);
      if (prev && Number(prev.t) >= ts) return false;
      byId.set(id, edge);
      _track(edge.type, id);
      return true;
    }

    function get(edge) {
      return byId.get(identityKey(edge)) || null;
    }

    function remove(edge) {
      const id = identityKey(edge);
      const prev = byId.get(id);
      if (!prev) return false;
      byId.delete(id);
      _untrack(prev.type, id);
      return true;
    }

    // Zero-allocation iteration. Callback receives the stored Edge object
    // by reference; callers must not mutate it.
    function forEach(cb) {
      for (const e of byId.values()) cb(e);
    }
    function forEachByType(type, cb) {
      const ids = byType.get(type);
      if (!ids) return;
      for (const id of ids) cb(byId.get(id));
    }

    function count() { return byId.size; }
    function countOfType(type) { const s = byType.get(type); return s ? s.size : 0; }

    function clear() { byId.clear(); byType.clear(); }
    function clearType(type) {
      const ids = byType.get(type);
      if (!ids) return;
      for (const id of ids) byId.delete(id);
      byType.delete(type);
    }

    return {
      put, putIfNewer, get, remove,
      forEach, forEachByType,
      count, countOfType,
      clear, clearType,
    };
  }

  const api = { createEdgeStore, registerIdentity, identityOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.edgeStoreModule = api;
})(typeof window !== 'undefined' ? window : null);
