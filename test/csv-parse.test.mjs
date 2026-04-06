// Tests for prototypes/csv-parse.js
// Run: node --test test/csv-parse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseCSVLine, parseHistoryCSV } = require('../prototypes/csv-parse.js');

// ── parseCSVLine ────────────────────────────────────────────────────────

test('parseCSVLine: plain fields', () => {
  assert.deepEqual(parseCSVLine('a,b,c'), ['a', 'b', 'c']);
});

test('parseCSVLine: trailing empty field', () => {
  assert.deepEqual(parseCSVLine('a,b,'), ['a', 'b', '']);
});

test('parseCSVLine: all empty', () => {
  assert.deepEqual(parseCSVLine(',,'), ['', '', '']);
});

test('parseCSVLine: quoted field with comma', () => {
  assert.deepEqual(
    parseCSVLine('"a, b",c'),
    ['a, b', 'c'],
  );
});

test('parseCSVLine: escaped doubled quote', () => {
  assert.deepEqual(
    parseCSVLine('"he said ""hi""",x'),
    ['he said "hi"', 'x'],
  );
});

test('parseCSVLine: quoted at beginning and end', () => {
  assert.deepEqual(
    parseCSVLine('"foo","bar","baz"'),
    ['foo', 'bar', 'baz'],
  );
});

// ── parseHistoryCSV ─────────────────────────────────────────────────────

test('parseHistoryCSV: builds nodes and edges', () => {
  const csv = [
    't,type,label,source,target,importance_xi,cluster',
    '0,NODE,cluster_a,0,,0.5,0',
    '0,NODE,func_x,1,function,0.8,0',
    '0,NODE,func_y,2,function,0.3,0',
    '1,EDGE,calls,1,2,,',
  ].join('\n');
  const { nodes, edges } = parseHistoryCSV(csv);
  assert.equal(nodes.length, 3);
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], { source: 'func_x', target: 'func_y', type: 'calls', weight: 1 });
});

test('parseHistoryCSV: cluster-defining node (idx === cluster col) flagged as type cluster', () => {
  const csv = [
    't,type,label,source,target,importance_xi,cluster',
    '0,NODE,MyCluster,5,,0.5,5',
    '0,NODE,member,6,function,0.2,5',
  ].join('\n');
  const { nodes } = parseHistoryCSV(csv);
  assert.equal(nodes.find(n => n.id === 'MyCluster').type, 'cluster');
  assert.equal(nodes.find(n => n.id === 'member').cluster, 'MyCluster');
});

test('parseHistoryCSV: memberOf EDGE reassigns cluster', () => {
  const csv = [
    't,type,label,source,target,importance_xi,cluster',
    '0,NODE,ClusterA,0,,0.5,0',
    '0,NODE,ClusterB,1,,0.5,1',
    '0,NODE,orphan,2,function,0.3,0',
    '1,EDGE,memberOf,2,1,,',
  ].join('\n');
  const { nodes } = parseHistoryCSV(csv);
  assert.equal(nodes.find(n => n.id === 'orphan').cluster, 'ClusterB');
});

test('parseHistoryCSV: edges touching cluster nodes are skipped (they are meta)', () => {
  const csv = [
    't,type,label,source,target,importance_xi,cluster',
    '0,NODE,ClusterA,0,,0.5,0',
    '0,NODE,func_x,1,function,0.5,0',
    '1,EDGE,meta,0,1,,',  // touches cluster — should be skipped (except memberOf)
  ].join('\n');
  const { edges } = parseHistoryCSV(csv);
  assert.equal(edges.length, 0);
});

test('parseHistoryCSV: nodeType falls back to importance heuristic when target empty', () => {
  const csv = [
    't,type,label,source,target,importance_xi,cluster',
    '0,NODE,big,0,,0.9,',
    '0,NODE,small,1,,0.05,',
  ].join('\n');
  const { nodes } = parseHistoryCSV(csv);
  assert.equal(nodes.find(n => n.id === 'big').type, 'function');
  assert.equal(nodes.find(n => n.id === 'small').type, 'global');
});

test('parseHistoryCSV: ignores unknown row types', () => {
  const csv = [
    't,type,label,source,target,importance_xi,cluster',
    '0,NODE,foo,0,function,0.5,',
    '1,ACTION,select,foo,,,',
    '2,DISTANCE,spatial,foo,bar,100,',
  ].join('\n');
  const { nodes, edges } = parseHistoryCSV(csv);
  assert.equal(nodes.length, 1);
  assert.equal(edges.length, 0);
});

test('parseHistoryCSV: empty CSV yields empty graph', () => {
  const { nodes, edges } = parseHistoryCSV('t,type,label,source,target,importance_xi,cluster');
  assert.deepEqual(nodes, []);
  assert.deepEqual(edges, []);
});
