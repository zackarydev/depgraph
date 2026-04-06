// Tests for prototypes/user-distances.js
// Run: node --test test/user-distances.test.mjs
//
// Covers the Edge-based API: the module accepts Edge domain objects with
// type='distance', keeps the most-recent entry per unordered {source,target}
// pair, and exposes iteration via a zero-allocation callback. There is no
// CSV knowledge here — callers do that conversion at the transport boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// The module holds module-level state, so re-require a fresh copy per test.
function freshModule() {
  const path = require.resolve('../prototypes/user-distances.js');
  delete require.cache[path];
  return require(path);
}

// Helper: build a distance edge with sane defaults.
function dedge(source, target, weight, t, type = 'distance') {
  return { source, target, type, weight, t };
}

test('applyEdge: happy path', () => {
  const m = freshModule();
  assert.equal(m.applyEdge(dedge('A', 'B', 100, 1)), true);
  assert.equal(m.edgeCount(), 1);
});

test('applyEdge: symmetric (A,B) and (B,A) collapse to one entry', () => {
  const m = freshModule();
  m.applyEdge(dedge('A', 'B', 100, 1));
  m.applyEdge(dedge('B', 'A', 150, 2));
  assert.equal(m.edgeCount(), 1);
  const seen = [];
  m.forEachEdge((a, b, w) => seen.push({ a, b, w }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].w, 150, 'most recent wins even with reversed pair order');
});

test('applyEdge: older t is rejected', () => {
  const m = freshModule();
  m.applyEdge(dedge('A', 'B', 100, 10));
  assert.equal(m.applyEdge(dedge('A', 'B', 200, 5)), false, 'older t rejected');
  const seen = [];
  m.forEachEdge((a, b, w) => seen.push(w));
  assert.equal(seen[0], 100);
});

test('applyEdge: equal t is rejected (no update)', () => {
  const m = freshModule();
  m.applyEdge(dedge('A', 'B', 100, 10));
  assert.equal(m.applyEdge(dedge('A', 'B', 200, 10)), false);
  const seen = [];
  m.forEachEdge((a, b, w) => seen.push(w));
  assert.equal(seen[0], 100);
});

test('applyEdge: rejects non-distance types', () => {
  const m = freshModule();
  assert.equal(m.applyEdge(dedge('A', 'B', 100, 1, 'calls')), false);
  assert.equal(m.applyEdge(dedge('A', 'B', 100, 1, 'memberOf')), false);
  assert.equal(m.applyEdge(dedge('A', 'B', 100, 1, '')), false);
  assert.equal(m.edgeCount(), 0);
});

test('applyEdge: rejects invalid inputs', () => {
  const m = freshModule();
  assert.equal(m.applyEdge(null), false, 'null');
  assert.equal(m.applyEdge(undefined), false, 'undefined');
  assert.equal(m.applyEdge(dedge('', 'B', 100, 1)), false, 'empty source');
  assert.equal(m.applyEdge(dedge('A', '', 100, 1)), false, 'empty target');
  assert.equal(m.applyEdge(dedge('A', 'A', 100, 1)), false, 'self pair');
  assert.equal(m.applyEdge(dedge('A', 'B', -5, 1)), false, 'negative weight');
  assert.equal(m.applyEdge(dedge('A', 'B', NaN, 1)), false, 'NaN weight');
  assert.equal(m.applyEdge(dedge('A', 'B', 'abc', 1)), false, 'unparseable weight');
  assert.equal(m.applyEdge(dedge('A', 'B', 100, 'bad')), false, 'unparseable t');
  assert.equal(m.edgeCount(), 0);
});

test('applyEdge: string weight/t coerced numerically', () => {
  const m = freshModule();
  assert.equal(m.applyEdge(dedge('A', 'B', '142.5', '1700')), true);
  const seen = [];
  m.forEachEdge((a, b, w) => seen.push(w));
  assert.equal(seen[0], 142.5);
});

test('applyEdges: batch returns count of edges stored', () => {
  const m = freshModule();
  const n = m.applyEdges([
    dedge('A', 'B', 100, 1),
    dedge('B', 'C', 50, 1),
    dedge('A', 'B', 999, 0), // older, rejected
    dedge('D', 'E', 75, 1, 'calls'), // wrong type
    null,
  ]);
  assert.equal(n, 2);
  assert.equal(m.edgeCount(), 2);
});

test('applyEdges: null/undefined input returns 0', () => {
  const m = freshModule();
  assert.equal(m.applyEdges(null), 0);
  assert.equal(m.applyEdges(undefined), 0);
  assert.equal(m.applyEdges([]), 0);
});

test('applyEdges: most-recent-wins regardless of order', () => {
  const m = freshModule();
  m.applyEdges([
    dedge('Foo', 'Bar', 100, 10),
    dedge('Foo', 'Bar', 200, 20),
    dedge('Foo', 'Bar', 999, 5),
  ]);
  assert.equal(m.edgeCount(), 1);
  const seen = [];
  m.forEachEdge((a, b, w) => seen.push(w));
  assert.equal(seen[0], 200, 'highest-t wins');
});

test('forEachEdge: invokes callback for each stored pair', () => {
  const m = freshModule();
  m.applyEdge(dedge('A', 'B', 100, 1));
  m.applyEdge(dedge('C', 'D', 200, 1));
  m.applyEdge(dedge('E', 'F', 300, 1));
  const seen = new Set();
  m.forEachEdge((a, b, w) => seen.add(`${a}|${b}|${w}`));
  assert.equal(seen.size, 3);
});

test('forEachEdge: weights survive round-trip', () => {
  const m = freshModule();
  m.applyEdge(dedge('Foo', 'Bar', 95.25, 1));
  const seen = [];
  m.forEachEdge((a, b, w) => seen.push({ a, b, w }));
  assert.equal(seen[0].w, 95.25);
});

test('forEachEdge: surfaces t so Edge objects can be reconstituted', () => {
  const m = freshModule();
  m.applyEdge(dedge('A', 'B', 100, 1700));
  m.applyEdge(dedge('C', 'D', 200, 1800));
  const rebuilt = [];
  m.forEachEdge((source, target, weight, t) => {
    rebuilt.push({ source, target, type: 'distance', weight, t });
  });
  assert.equal(rebuilt.length, 2);
  // Re-applying the reconstituted edges to a fresh store yields the same
  // state — the round-trip is lossless.
  const m2 = freshModule();
  assert.equal(m2.applyEdges(rebuilt), 2);
  assert.equal(m2.edgeCount(), 2);
  const ts = new Set();
  m2.forEachEdge((a, b, w, t) => ts.add(t));
  assert.ok(ts.has(1700) && ts.has(1800));
});

test('clear: empties store', () => {
  const m = freshModule();
  m.applyEdge(dedge('A', 'B', 100, 1));
  m.applyEdge(dedge('C', 'D', 200, 1));
  assert.equal(m.edgeCount(), 2);
  m.clear();
  assert.equal(m.edgeCount(), 0);
  let count = 0;
  m.forEachEdge(() => count++);
  assert.equal(count, 0);
});
