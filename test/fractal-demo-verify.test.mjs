/**
 * Verifies the hand-authored `add` fractal demo produces a strict 4-level
 * nested cluster shape: cluster:add (root) -> 4 L1 -> 8 L2 -> 18 atoms.
 * Every atom must be exactly 3 expansions deep so depth-based fractal LOD
 * has a single threshold per level.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateAddFractalHistory } from '../src/data/demo-add-fractal.js';
import { createHistory, append as historyAppend, effectiveRows } from '../src/data/history.js';
import { buildFromHistory } from '../src/data/graph-builder.js';
import { deriveAll } from '../src/data/derive.js';
import { createPropertyRegistry } from '../src/core/properties.js';

describe('demo-add-fractal: nested cluster shape', () => {
  const h = createHistory();
  for (const r of generateAddFractalHistory()) historyAppend(h, r);
  const eff = effectiveRows(h);
  const g = buildFromHistory(eff, undefined, createPropertyRegistry());
  const d = deriveAll(g.state.nodes, g.state.edges);

  it('produces 1 + 4 + 8 + 18 = 31 nodes', () => {
    assert.equal(g.state.nodes.size, 31);
  });

  it('all 13 cluster ids are well-formed (no double prefix)', () => {
    const ids = [...d.clusters.keys()].sort();
    for (const id of ids) assert.ok(!id.startsWith('cluster:cluster:'), `double-prefix: ${id}`);
    assert.equal(ids.length, 13);
  });

  it('cluster:add (root) has the four L1 nodes as members', () => {
    const root = d.clusters.get('cluster:add');
    assert.deepEqual(
      [...root.members].sort(),
      ['L1_args', 'L1_body', 'L1_decl', 'L1_ret']
    );
  });

  it('every atom sits exactly 3 expansions below the root', () => {
    // depth(node) = 1 + depth(parent cluster's target node), root atom 'add' has depth 0
    const memberToCluster = new Map();
    for (const [cid, c] of d.clusters) {
      for (const m of c.members) memberToCluster.set(m, cid);
    }
    function depth(id) {
      let n = 0;
      let cur = id;
      while (memberToCluster.has(cur)) {
        const cid = memberToCluster.get(cur);
        cur = cid.replace(/^cluster:/, '');
        n++;
        if (n > 10) throw new Error(`cycle at ${id}`);
      }
      return n;
    }
    const atoms = [...g.state.nodes.keys()].filter(id => id.startsWith('tok_'));
    assert.equal(atoms.length, 18);
    for (const a of atoms) assert.equal(depth(a), 3, `atom ${a} should be at depth 3`);
  });
});
