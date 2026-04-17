/**
 * Phase 12 — Moment/rule substrate tests.
 *
 * Proves the minimum dispatcher substrate works: HLC coords, emit/retract,
 * per-frame tick composition, and — critically — parity with the legacy
 * bespoke gather implementation. If parity holds, the rule substrate is
 * a drop-in replacement and every future interaction can be expressed as
 * a rule instead of a hand-wired handler.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHLC, compareHLC, parseHLC } from '../src/core/clock.js';
import {
  createDispatcher,
  registerRule,
  emit,
  retract,
  commit,
  tick,
  liveMoments,
} from '../src/core/dispatcher.js';
import { gatherRule, gatherCentroid, neighborsOf } from '../src/rules/gather.js';
import {
  createPositionMap,
  updatePosition,
  setLocked,
} from '../src/layout/positions.js';
import { createSelection, selectMany } from '../src/interact/select.js';
import {
  startGather as legacyStartGather,
  startStrangerGather as legacyStartStrangerGather,
  updateGather as legacyUpdateGather,
  startClusterGather as legacyStartClusterGather,
} from '../src/interact/gather.js';
import {
  SENTINEL_MOUSE_CLICKED,
  CLICK_EDGE_LAYER,
  clickEdgeId,
  sentinelRow,
  lastClickTarget,
} from '../src/rules/click-events.js';
import { buildFromHistory, applyRowToGraph } from '../src/data/graph-builder.js';
import { createHistory, append as historyAppend } from '../src/data/history.js';

describe('core/clock (HLC)', () => {
  it('advances monotonically within one producer', () => {
    const clk = createHLC('ui');
    const a = parseHLC(clk.next());
    const b = parseHLC(clk.next());
    const strictlyAfter =
      b.wallMs > a.wallMs || (b.wallMs === a.wallMs && b.counter > a.counter);
    assert.ok(strictlyAfter, 'second coord must be strictly after first');
  });

  it('compareHLC totally orders same-producer coords', () => {
    const clk = createHLC('p1');
    clk.next();
    const a = clk.snapshot();
    clk.next();
    const b = clk.snapshot();
    assert.equal(compareHLC(a, b), -1);
    assert.equal(compareHLC(b, a), 1);
    assert.equal(compareHLC(a, a), 0);
  });

  it('returns null for concurrent coords from different producers at same wallMs', () => {
    const a = { wallMs: 100, producerId: 'p1', counter: 0 };
    const b = { wallMs: 100, producerId: 'p2', counter: 0 };
    assert.equal(compareHLC(a, b), null);
  });

  it('observe() advances clock past an observed coord', () => {
    const clk = createHLC('p1');
    clk.observe({ wallMs: Date.now() + 10000, producerId: 'p2', counter: 5 });
    const snap = clk.snapshot();
    assert.ok(snap.wallMs > Date.now() + 5000);
    assert.equal(snap.counter, 6);
  });
});

describe('core/dispatcher', () => {
  it('registers a rule and emits a live moment', () => {
    const d = createDispatcher({ producerId: 'ui' });
    registerRule(d, gatherRule);
    const m = emit(d, {
      rule: 'gather',
      members: ['a', 'b'],
      payload: { targetX: 0, targetY: 0 },
    });
    assert.equal(m.state, 'live');
    assert.equal(m.rule, 'gather');
    assert.deepEqual(m.members, ['a', 'b']);
    assert.equal(liveMoments(d).length, 1);
    assert.equal(m.clock.producerId, 'ui');
    assert.ok(typeof m.clock.wallMs === 'number');
  });

  it('throws on emit with unknown rule', () => {
    const d = createDispatcher();
    assert.throws(() => emit(d, { rule: 'not-a-rule', members: [] }));
  });

  it('throws on registerRule with missing name or tick', () => {
    const d = createDispatcher();
    assert.throws(() => registerRule(d, {}));
    assert.throws(() => registerRule(d, { name: 'x' }));
  });

  it('retract moves moment from live -> log with state=retracted', () => {
    const d = createDispatcher();
    registerRule(d, gatherRule);
    const m = emit(d, {
      rule: 'gather',
      members: ['a'],
      payload: { targetX: 0, targetY: 0 },
    });
    retract(d, m.id);
    assert.equal(liveMoments(d).length, 0);
    assert.equal(d.log.length, 1);
    assert.equal(d.log[0].state, 'retracted');
  });

  it('commit moves moment from live -> log with state=committed', () => {
    const d = createDispatcher();
    registerRule(d, gatherRule);
    const m = emit(d, {
      rule: 'gather',
      members: ['a'],
      payload: { targetX: 0, targetY: 0 },
    });
    commit(d, m.id);
    assert.equal(liveMoments(d).length, 0);
    assert.equal(d.log[0].state, 'committed');
  });

  it('tick pulls members toward target', () => {
    const d = createDispatcher();
    registerRule(d, gatherRule);
    const pm = createPositionMap();
    updatePosition(pm, 'a', 100, 0);
    updatePosition(pm, 'b', 0, 100);
    emit(d, {
      rule: 'gather',
      members: ['a', 'b'],
      payload: { targetX: 0, targetY: 0, strength: 10 },
    });
    const result = tick(d, 100, { posMap: pm });
    assert.ok(result.moved.includes('a'));
    assert.ok(result.moved.includes('b'));
    assert.ok(pm.positions.get('a').x < 100);
    assert.ok(pm.positions.get('b').y < 100);
  });

  it('tick sums contributions when multiple moments target the same node', () => {
    const d = createDispatcher();
    registerRule(d, gatherRule);
    const pm = createPositionMap();
    updatePosition(pm, 'a', 0, 0);
    emit(d, {
      rule: 'gather',
      members: ['a'],
      payload: { targetX: 100, targetY: 0, strength: 10 },
    });
    emit(d, {
      rule: 'gather',
      members: ['a'],
      payload: { targetX: 0, targetY: 100, strength: 10 },
    });
    tick(d, 100, { posMap: pm });
    const a = pm.positions.get('a');
    assert.ok(a.x > 0, 'x should feel pull 1');
    assert.ok(a.y > 0, 'y should feel pull 2');
  });

  it('tick skips locked members', () => {
    const d = createDispatcher();
    registerRule(d, gatherRule);
    const pm = createPositionMap();
    updatePosition(pm, 'a', 100, 0);
    setLocked(pm, 'a', true);
    emit(d, {
      rule: 'gather',
      members: ['a'],
      payload: { targetX: 0, targetY: 0, strength: 10 },
    });
    tick(d, 100, { posMap: pm });
    assert.equal(pm.positions.get('a').x, 100);
  });

  it('retracted moments no longer contribute', () => {
    const d = createDispatcher();
    registerRule(d, gatherRule);
    const pm = createPositionMap();
    updatePosition(pm, 'a', 100, 0);
    const m = emit(d, {
      rule: 'gather',
      members: ['a'],
      payload: { targetX: 0, targetY: 0, strength: 10 },
    });
    retract(d, m.id);
    tick(d, 100, { posMap: pm });
    assert.equal(pm.positions.get('a').x, 100);
  });
});

describe('rules/gather', () => {
  it('gatherCentroid returns the mean position of members', () => {
    const pm = createPositionMap();
    updatePosition(pm, 'a', 0, 0);
    updatePosition(pm, 'b', 100, 100);
    assert.deepEqual(gatherCentroid(['a', 'b'], pm), { x: 50, y: 50 });
  });

  it('gatherCentroid returns null for an empty set', () => {
    const pm = createPositionMap();
    assert.equal(gatherCentroid([], pm), null);
  });

  it('gather converges a member monotonically toward its target', () => {
    const d = createDispatcher();
    registerRule(d, gatherRule);
    const pm = createPositionMap();
    updatePosition(pm, 'a', 100, 0);
    emit(d, {
      rule: 'gather',
      members: ['a'],
      payload: { targetX: 0, targetY: 0, strength: 3.0 },
    });
    let prev = pm.positions.get('a').x;
    for (let i = 0; i < 15; i++) {
      tick(d, 100, { posMap: pm });
      const now = pm.positions.get('a').x;
      assert.ok(now <= prev + 1e-9, `frame ${i}: monotonic`);
      prev = now;
    }
    assert.ok(prev < 100, 'member moved');
  });

  it('neighborsOf returns only non-excluded neighbors', () => {
    const edges = new Map([
      ['e1', { id: 'e1', source: 'a', target: 'b', layer: 'calls', weight: 1 }],
      ['e2', { id: 'e2', source: 'a', target: 'c', layer: 'calls', weight: 1 }],
      ['e3', { id: 'e3', source: 'd', target: 'a', layer: 'reads', weight: 1 }],
    ]);
    const result = neighborsOf('a', edges, new Set(['c']));
    assert.deepEqual(new Set(result), new Set(['b', 'd']));
  });
});

describe('substrate parity with legacy gather', () => {
  // Both paths run the same math on two copies of the same posMap.
  // After N identical dt frames, the positions must match to within eps.
  it('centroid gather: substrate trajectory == legacy trajectory', () => {
    const pmLegacy = createPositionMap();
    const pmSub = createPositionMap();
    for (const pm of [pmLegacy, pmSub]) {
      updatePosition(pm, 'a', 100, 0);
      updatePosition(pm, 'b', 0, 100);
      updatePosition(pm, 'c', -100, 0);
    }

    // legacy: startGather on a 3-node selection
    const sel = selectMany(['a', 'b', 'c']);
    const g = legacyStartGather(sel, pmLegacy);
    for (let i = 0; i < 30; i++) legacyUpdateGather(g, 50, pmLegacy);

    // substrate: same target (the centroid that legacy computed), same strength
    const d = createDispatcher();
    registerRule(d, gatherRule);
    const c = gatherCentroid(['a', 'b', 'c'], pmSub);
    emit(d, {
      rule: 'gather',
      members: ['a', 'b', 'c'],
      payload: { targetX: c.x, targetY: c.y, strength: 3.0 },
    });
    for (let i = 0; i < 30; i++) tick(d, 50, { posMap: pmSub });

    for (const id of ['a', 'b', 'c']) {
      const L = pmLegacy.positions.get(id);
      const S = pmSub.positions.get(id);
      assert.ok(Math.abs(L.x - S.x) < 1e-9, `${id}.x parity: legacy=${L.x} sub=${S.x}`);
      assert.ok(Math.abs(L.y - S.y) < 1e-9, `${id}.y parity: legacy=${L.y} sub=${S.y}`);
    }
  });

  it('cluster gather: substrate trajectory == legacy startClusterGather', () => {
    // Build a toy graph with cluster node C and three members a/b/c.
    // Pre-seed positions so the two paths see identical initial state.
    const initial = [
      { type: 'NODE', op: 'add', id: 'C', kind: 'cluster', label: 'C', weight: 5 },
      { type: 'NODE', op: 'add', id: 'a', kind: 'function', label: 'a' },
      { type: 'NODE', op: 'add', id: 'b', kind: 'function', label: 'b' },
      { type: 'NODE', op: 'add', id: 'c', kind: 'function', label: 'c' },
      { type: 'EDGE', op: 'add', id: 'a->C', source: 'a', target: 'C', layer: 'memberOf', weight: 5 },
      { type: 'EDGE', op: 'add', id: 'b->C', source: 'b', target: 'C', layer: 'memberOf', weight: 5 },
      { type: 'EDGE', op: 'add', id: 'c->C', source: 'c', target: 'C', layer: 'memberOf', weight: 5 },
    ].map((r, i) => ({ ...r, t: i }));

    const graph = buildFromHistory(initial);
    // derivation keys clusters as `cluster:${edge.target}`
    const clusterKey = 'cluster:C';
    assert.ok(graph.derivation.clusters.has(clusterKey), 'cluster derived under expected key');

    const pmLegacy = createPositionMap();
    const pmSub = createPositionMap();
    for (const pm of [pmLegacy, pmSub]) {
      updatePosition(pm, 'C', 0, 0);
      updatePosition(pm, 'a', 100, 0);
      updatePosition(pm, 'b', -100, 0);
      updatePosition(pm, 'c', 0, 100);
    }

    // Legacy path
    const legacyCluster = { members: new Set(['a', 'b', 'c']) };
    const g = legacyStartClusterGather(legacyCluster, pmLegacy);
    for (let i = 0; i < 30; i++) legacyUpdateGather(g, 50, pmLegacy);

    // Substrate path — members resolved from the cluster id via derivation
    const members = [...graph.derivation.clusters.get(clusterKey).members];
    const target = gatherCentroid(members, pmSub);
    const d = createDispatcher();
    registerRule(d, gatherRule);
    emit(d, {
      rule: 'gather',
      members,
      payload: { targetX: target.x, targetY: target.y, strength: 3.0 },
    });
    for (let i = 0; i < 30; i++) tick(d, 50, { posMap: pmSub });

    for (const id of ['a', 'b', 'c']) {
      const L = pmLegacy.positions.get(id);
      const S = pmSub.positions.get(id);
      assert.ok(Math.abs(L.x - S.x) < 1e-9, `${id}.x parity: legacy=${L.x} sub=${S.x}`);
      assert.ok(Math.abs(L.y - S.y) < 1e-9, `${id}.y parity: legacy=${L.y} sub=${S.y}`);
    }
  });

  it('stranger gather: substrate trajectory == legacy trajectory', () => {
    const edges = new Map([
      ['e1', { id: 'e1', source: 'anchor', target: 'n1', layer: 'calls', weight: 1 }],
      ['e2', { id: 'e2', source: 'anchor', target: 'n2', layer: 'calls', weight: 1 }],
    ]);

    const pmLegacy = createPositionMap();
    const pmSub = createPositionMap();
    for (const pm of [pmLegacy, pmSub]) {
      updatePosition(pm, 'anchor', 0, 0);
      updatePosition(pm, 'n1', 100, 0);
      updatePosition(pm, 'n2', 0, 100);
    }

    const selL = createSelection();
    const g = legacyStartStrangerGather('anchor', edges, selL, pmLegacy);
    for (let i = 0; i < 20; i++) legacyUpdateGather(g, 50, pmLegacy);

    const d = createDispatcher();
    registerRule(d, gatherRule);
    const anchorPos = pmSub.positions.get('anchor');
    const members = neighborsOf('anchor', edges, new Set());
    emit(d, {
      rule: 'gather',
      members,
      payload: { targetX: anchorPos.x, targetY: anchorPos.y, strength: 3.0 },
    });
    for (let i = 0; i < 20; i++) tick(d, 50, { posMap: pmSub });

    for (const id of ['n1', 'n2']) {
      const L = pmLegacy.positions.get(id);
      const S = pmSub.positions.get(id);
      assert.ok(Math.abs(L.x - S.x) < 1e-9, `${id}.x parity`);
      assert.ok(Math.abs(L.y - S.y) < 1e-9, `${id}.y parity`);
    }
  });
});

describe('click events as graph edges', () => {
  it('clickEdgeId is unique per (t, target) pair', () => {
    assert.notEqual(clickEdgeId(1, 'a'), clickEdgeId(2, 'a'));
    assert.notEqual(clickEdgeId(1, 'a'), clickEdgeId(1, 'b'));
  });

  it('lastClickTarget returns null on an empty graph', () => {
    const graph = buildFromHistory([]);
    assert.equal(lastClickTarget(graph), null);
  });

  it('lastClickTarget tracks the most recent click edge from the sentinel', () => {
    const history = createHistory();
    historyAppend(history, sentinelRow());
    historyAppend(history, { type: 'NODE', op: 'add', id: 'n1', kind: 'function' });
    historyAppend(history, { type: 'NODE', op: 'add', id: 'n2', kind: 'function' });
    const graph = buildFromHistory(history.rows);
    assert.ok(graph.state.nodes.has(SENTINEL_MOUSE_CLICKED));

    // Simulate two clicks in order; assert lastClickTarget reflects the latest.
    const click1 = historyAppend(history, {
      type: 'EDGE', op: 'add',
      id: clickEdgeId(history.nextT, 'n1'),
      source: SENTINEL_MOUSE_CLICKED, target: 'n1',
      layer: CLICK_EDGE_LAYER, weight: 0,
    });
    applyRowToGraph(graph, click1);
    assert.equal(lastClickTarget(graph), 'n1');

    const click2 = historyAppend(history, {
      type: 'EDGE', op: 'add',
      id: clickEdgeId(history.nextT, 'n2'),
      source: SENTINEL_MOUSE_CLICKED, target: 'n2',
      layer: CLICK_EDGE_LAYER, weight: 0,
    });
    applyRowToGraph(graph, click2);
    assert.equal(lastClickTarget(graph), 'n2');
  });

  it('click edges on a cluster id resolve to cluster-gather members', () => {
    // End-to-end: a cluster exists, user clicks the cluster, lastClickTarget
    // lands on a derivation cluster key, members resolve via cluster-rules.
    const history = createHistory();
    historyAppend(history, sentinelRow());
    const nodeRows = [
      { type: 'NODE', op: 'add', id: 'C', kind: 'cluster', label: 'C', weight: 5 },
      { type: 'NODE', op: 'add', id: 'a', kind: 'function', label: 'a' },
      { type: 'NODE', op: 'add', id: 'b', kind: 'function', label: 'b' },
      { type: 'EDGE', op: 'add', id: 'a->C', source: 'a', target: 'C', layer: 'memberOf', weight: 5 },
      { type: 'EDGE', op: 'add', id: 'b->C', source: 'b', target: 'C', layer: 'memberOf', weight: 5 },
    ];
    for (const r of nodeRows) historyAppend(history, r);
    const graph = buildFromHistory(history.rows);

    const clusterKey = 'cluster:C';
    assert.ok(graph.derivation.clusters.has(clusterKey));

    const click = historyAppend(history, {
      type: 'EDGE', op: 'add',
      id: clickEdgeId(history.nextT, clusterKey),
      source: SENTINEL_MOUSE_CLICKED, target: clusterKey,
      layer: CLICK_EDGE_LAYER, weight: 0,
    });
    applyRowToGraph(graph, click);

    const clicked = lastClickTarget(graph);
    assert.equal(clicked, clusterKey);
    assert.ok(graph.derivation.clusters.has(clicked), 'clicked id is a cluster key');
    const members = graph.derivation.clusters.get(clicked).members;
    assert.deepEqual(new Set(members), new Set(['a', 'b']));
  });

  it('event:click edges do not create spurious clusters or distort affinities', () => {
    // Sanity: the event layer has zero weight, so clicks accumulate in history
    // without warping the graph. Build a graph, spray a bunch of click edges,
    // confirm the non-sentinel clusters are unchanged.
    const baseRows = [
      { type: 'NODE', op: 'add', id: 'C', kind: 'cluster', label: 'C', weight: 5 },
      { type: 'NODE', op: 'add', id: 'a', kind: 'function', label: 'a' },
      { type: 'NODE', op: 'add', id: 'b', kind: 'function', label: 'b' },
      { type: 'EDGE', op: 'add', id: 'a->C', source: 'a', target: 'C', layer: 'memberOf', weight: 5 },
      { type: 'EDGE', op: 'add', id: 'b->C', source: 'b', target: 'C', layer: 'memberOf', weight: 5 },
    ].map((r, i) => ({ ...r, t: i }));

    const history = createHistory();
    historyAppend(history, sentinelRow());
    for (const r of baseRows) historyAppend(history, r);
    const before = buildFromHistory(history.rows);
    const beforeMembers = new Set(before.derivation.clusters.get('cluster:C').members);

    for (const target of ['a', 'b', 'C', 'cluster:C', 'a', 'b']) {
      historyAppend(history, {
        type: 'EDGE', op: 'add',
        id: clickEdgeId(history.nextT, target),
        source: SENTINEL_MOUSE_CLICKED, target,
        layer: CLICK_EDGE_LAYER, weight: 0,
      });
    }
    const after = buildFromHistory(history.rows);
    const afterMembers = new Set(after.derivation.clusters.get('cluster:C').members);
    assert.deepEqual(afterMembers, beforeMembers, 'cluster membership unchanged by clicks');
  });
});
