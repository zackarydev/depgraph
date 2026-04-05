// Tests for prototypes/user-distances.js
// Run: node --test test/user-distances.test.mjs
//
// These cover the pure-logic core of Plan 2 Option E: canonical pair keying,
// most-recent-wins semantics, CSV parsing of DISTANCE rows, and the end-to-end
// ingest of a user-actions.csv payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// The module is a UMD-style IIFE; require() picks up the module.exports path.
// We need a fresh instance per test because userDistances is shared state, so
// re-require via decache-by-delete on module cache.
function freshModule() {
  const path = require.resolve('../prototypes/user-distances.js');
  delete require.cache[path];
  return require(path);
}

test('_pairKey is canonical (unordered)', () => {
  const { _pairKey } = freshModule();
  assert.equal(_pairKey('A', 'B'), _pairKey('B', 'A'));
  assert.equal(_pairKey('zoo', 'ant'), _pairKey('ant', 'zoo'));
  assert.notEqual(_pairKey('A', 'B'), _pairKey('A', 'C'));
});

test('updateUserDistance: happy path', () => {
  const { userDistances, updateUserDistance } = freshModule();
  assert.equal(updateUserDistance('A', 'B', 100, 1), true);
  assert.equal(userDistances.size, 1);
  const entry = userDistances.values().next().value;
  assert.equal(entry.dist, 100);
  assert.equal(entry.t, 1);
});

test('updateUserDistance: symmetric (A,B) and (B,A) collapse to one entry', () => {
  const { userDistances, updateUserDistance } = freshModule();
  updateUserDistance('A', 'B', 100, 1);
  updateUserDistance('B', 'A', 150, 2);
  assert.equal(userDistances.size, 1);
  const entry = userDistances.values().next().value;
  assert.equal(entry.dist, 150, 'most recent wins even with reversed pair order');
  assert.equal(entry.t, 2);
});

test('updateUserDistance: older t is rejected', () => {
  const { userDistances, updateUserDistance } = freshModule();
  updateUserDistance('A', 'B', 100, 10);
  assert.equal(updateUserDistance('A', 'B', 200, 5), false, 'older t rejected');
  assert.equal(userDistances.get(userDistances.keys().next().value).dist, 100);
});

test('updateUserDistance: equal t is rejected (no update)', () => {
  const { userDistances, updateUserDistance } = freshModule();
  updateUserDistance('A', 'B', 100, 10);
  assert.equal(updateUserDistance('A', 'B', 200, 10), false);
  assert.equal(userDistances.get(userDistances.keys().next().value).dist, 100);
});

test('updateUserDistance: rejects invalid inputs', () => {
  const { userDistances, updateUserDistance } = freshModule();
  assert.equal(updateUserDistance('', 'B', 100, 1), false, 'empty a');
  assert.equal(updateUserDistance('A', '', 100, 1), false, 'empty b');
  assert.equal(updateUserDistance('A', 'A', 100, 1), false, 'self pair');
  assert.equal(updateUserDistance('A', 'B', -5, 1), false, 'negative dist');
  assert.equal(updateUserDistance('A', 'B', NaN, 1), false, 'NaN dist');
  assert.equal(updateUserDistance('A', 'B', 'abc', 1), false, 'unparseable dist');
  assert.equal(updateUserDistance('A', 'B', 100, 'bad'), false, 'unparseable t');
  assert.equal(userDistances.size, 0);
});

test('updateUserDistance: string inputs coerced numerically', () => {
  const { userDistances, updateUserDistance } = freshModule();
  assert.equal(updateUserDistance('A', 'B', '142.5', '1700'), true);
  const entry = userDistances.values().next().value;
  assert.equal(entry.dist, 142.5);
  assert.equal(entry.t, 1700);
});

test('parseCSVLine: plain fields', () => {
  const { parseCSVLine } = freshModule();
  assert.deepEqual(parseCSVLine('1,2,three,four'), ['1', '2', 'three', 'four']);
});

test('parseCSVLine: quoted field with comma', () => {
  const { parseCSVLine } = freshModule();
  assert.deepEqual(
    parseCSVLine('1,NODE,"foo, bar",3,,0.5,0'),
    ['1', 'NODE', 'foo, bar', '3', '', '0.5', '0'],
  );
});

test('parseCSVLine: escaped quote inside quoted field', () => {
  const { parseCSVLine } = freshModule();
  assert.deepEqual(parseCSVLine('a,"he said ""hi""",b'), ['a', 'he said "hi"', 'b']);
});

test('ingestUserActionsCSV: applies DISTANCE rows, ignores others', () => {
  const { userDistances, ingestUserActionsCSV } = freshModule();
  const csv = [
    't,type,label,source,target,importance_xi,cluster',
    '1,ACTION,stick,Foo,,,',
    '2,DISTANCE,spatial,Foo,Bar,100,',
    '3,ACTION,select,Baz,,,',
    '4,DISTANCE,spatial,Foo,Qux,50,',
  ].join('\n');
  const n = ingestUserActionsCSV(csv);
  assert.equal(n, 2, 'two DISTANCE rows applied');
  assert.equal(userDistances.size, 2);
});

test('ingestUserActionsCSV: most-recent-wins across the log', () => {
  const { userDistances, ingestUserActionsCSV } = freshModule();
  const csv = [
    't,type,label,source,target,importance_xi,cluster',
    '10,DISTANCE,spatial,Foo,Bar,100,',
    '20,DISTANCE,spatial,Foo,Bar,200,',
    '5,DISTANCE,spatial,Foo,Bar,999,',
  ].join('\n');
  ingestUserActionsCSV(csv);
  assert.equal(userDistances.size, 1);
  const entry = userDistances.values().next().value;
  assert.equal(entry.dist, 200, 'highest-t wins regardless of row order');
  assert.equal(entry.t, 20);
});

test('ingestUserActionsCSV: handles quoted node names with commas', () => {
  const { userDistances, ingestUserActionsCSV } = freshModule();
  const csv = [
    't,type,label,source,target,importance_xi,cluster',
    '1,DISTANCE,spatial,"AST Analysis","Node, with comma",95.25,',
  ].join('\n');
  ingestUserActionsCSV(csv);
  assert.equal(userDistances.size, 1);
  const entry = userDistances.values().next().value;
  assert.equal(entry.dist, 95.25);
});

test('ingestUserActionsCSV: tolerates blank lines and trailing whitespace', () => {
  const { userDistances, ingestUserActionsCSV } = freshModule();
  const csv =
    't,type,label,source,target,importance_xi,cluster\n' +
    '\n' +
    '1,DISTANCE,spatial,Foo,Bar,100,\n' +
    '  \n' +
    '2,DISTANCE,spatial,Foo,Baz,50,\n';
  // Note: the trimmed whitespace-only line is preserved as a non-empty line
  // by trim().split('\n'), so it must be tolerated inside parseCSVLine/updateUserDistance.
  ingestUserActionsCSV(csv);
  assert.equal(userDistances.size, 2);
});

test('ingestUserActionsCSV: header-only CSV applies zero rows', () => {
  const { userDistances, ingestUserActionsCSV } = freshModule();
  const csv = 't,type,label,source,target,importance_xi,cluster';
  assert.equal(ingestUserActionsCSV(csv), 0);
  assert.equal(userDistances.size, 0);
});

test('ingestUserActionsCSV: rejects malformed DISTANCE rows silently', () => {
  const { userDistances, ingestUserActionsCSV } = freshModule();
  const csv = [
    't,type,label,source,target,importance_xi,cluster',
    '1,DISTANCE,spatial,,Bar,100,',       // empty source
    '2,DISTANCE,spatial,Foo,,100,',       // empty target
    '3,DISTANCE,spatial,Foo,Bar,-5,',     // negative distance
    '4,DISTANCE,spatial,Foo,Bar,100,',    // valid
  ].join('\n');
  assert.equal(ingestUserActionsCSV(csv), 1);
  assert.equal(userDistances.size, 1);
});
