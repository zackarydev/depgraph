/**
 * Phase 6 — Interaction engine tests.
 *
 * Tests the pure-logic contracts for all interact modules:
 * select, drag, keyboard, reset, time-travel, gather, attractor, trace.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSelection,
  selectNode,
  toggleSelection,
  clearSelection,
  isSelected,
  selectionCount,
  selectMany,
} from '../src/interact/select.js';

import {
  startDrag,
  onDrag,
  endDrag,
  draggedNodes,
} from '../src/interact/drag.js';

import {
  createKeyState,
  keyDown,
  keyUp,
  setPointerDepth,
  isPositionModeBusy,
  clearActiveMode,
} from '../src/interact/keyboard.js';

import {
  startReset,
  updateReset,
  stopReset,
  resetSingleNode,
} from '../src/interact/reset.js';

import {
  startTimeTravel,
  updateTimeTravel,
  stopTimeTravel,
  stepOnce,
  timeTravelStatus,
} from '../src/interact/time-travel.js';

import {
  centroid,
  startGather,
  startStrangerGather,
  startGroupGather,
  startClusterGather,
  updateGather,
  stopGather,
} from '../src/interact/gather.js';

import {
  startAttractor,
  bfsNeighbors,
  updateAttractor,
  stopAttractor,
} from '../src/interact/attractor.js';

import {
  buildAdjacency,
  computeBFS,
  startTrace,
  flashTrace,
  updateTrace,
  holdTrace,
  releaseTrace,
  revealedNodes,
  revealedEdges,
} from '../src/interact/trace.js';

import { createPositionMap, ensurePosition } from '../src/layout/positions.js';
import { createContext } from '../src/core/context.js';
import { createHistory, append, load } from '../src/data/history.js';

// ─── Helpers ───

function makeEdge(id, source, target, layer = 'calls', weight = 1) {
  return { id, source, target, layer, weight, directed: true };
}

function makeEdgeMap(...edges) {
  return new Map(edges.map(e => [e.id, e]));
}

function makePosMap(entries) {
  const pm = createPositionMap();
  for (const [id, x, y] of entries) ensurePosition(pm, id, x, y);
  return pm;
}

// ─────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────

describe('interact/select', () => {
  it('createSelection starts empty', () => {
    const sel = createSelection();
    assert.equal(sel.primary, null);
    assert.equal(sel.selected.size, 0);
  });

  it('selectNode sets primary and single selection', () => {
    const sel = selectNode(createSelection(), 'a');
    assert.equal(sel.primary, 'a');
    assert.equal(sel.selected.size, 1);
    assert.ok(sel.selected.has('a'));
  });

  it('selectNode replaces previous selection', () => {
    let sel = selectNode(createSelection(), 'a');
    sel = selectNode(sel, 'b');
    assert.equal(sel.primary, 'b');
    assert.equal(sel.selected.size, 1);
    assert.ok(!sel.selected.has('a'));
  });

  it('toggleSelection adds to multi-select', () => {
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    assert.equal(sel.primary, 'b');
    assert.equal(sel.selected.size, 2);
    assert.ok(sel.selected.has('a'));
    assert.ok(sel.selected.has('b'));
  });

  it('toggleSelection removes if already selected', () => {
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    sel = toggleSelection(sel, 'a');
    assert.equal(sel.selected.size, 1);
    assert.ok(!sel.selected.has('a'));
    assert.ok(sel.selected.has('b'));
  });

  it('clearSelection empties everything', () => {
    let sel = selectNode(createSelection(), 'a');
    sel = clearSelection(sel);
    assert.equal(sel.primary, null);
    assert.equal(sel.selected.size, 0);
  });

  it('isSelected checks membership', () => {
    const sel = selectNode(createSelection(), 'a');
    assert.ok(isSelected(sel, 'a'));
    assert.ok(!isSelected(sel, 'b'));
  });

  it('selectionCount returns count', () => {
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    assert.equal(selectionCount(sel), 2);
  });

  it('selectMany selects a group at once', () => {
    const sel = selectMany(['a', 'b', 'c']);
    assert.equal(sel.selected.size, 3);
    assert.ok(sel.primary != null);
  });
});

// ─────────────────────────────────────────────────
// Drag
// ─────────────────────────────────────────────────

describe('interact/drag', () => {
  it('startDrag returns null for unknown node', () => {
    const pm = makePosMap([['a', 0, 0]]);
    const sel = selectNode(createSelection(), 'a');
    assert.equal(startDrag('z', pm, sel, false), null);
  });

  it('startDrag creates single-node drag state', () => {
    const pm = makePosMap([['a', 10, 20]]);
    const sel = selectNode(createSelection(), 'a');
    const drag = startDrag('a', pm, sel, false);
    assert.ok(drag);
    assert.equal(drag.nodeId, 'a');
    assert.equal(drag.isGroup, false);
    assert.equal(drag.startX, 10);
  });

  it('onDrag updates position', () => {
    const pm = makePosMap([['a', 10, 20]]);
    const sel = selectNode(createSelection(), 'a');
    const drag = startDrag('a', pm, sel, false);
    onDrag(drag, 50, 60, pm);
    assert.equal(pm.positions.get('a').x, 50);
    assert.equal(pm.positions.get('a').y, 60);
  });

  it('endDrag returns history rows and makes node sticky', () => {
    const pm = makePosMap([['a', 10, 20]]);
    const sel = selectNode(createSelection(), 'a');
    const drag = startDrag('a', pm, sel, false);
    onDrag(drag, 50, 60, pm);
    const rows = endDrag(drag, pm);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'NODE');
    assert.equal(rows[0].payload.action, 'drag');
    assert.ok(pm.positions.get('a').sticky);
  });

  it('endDrag returns empty if no movement', () => {
    const pm = makePosMap([['a', 10, 20]]);
    const sel = selectNode(createSelection(), 'a');
    const drag = startDrag('a', pm, sel, false);
    const rows = endDrag(drag, pm);
    assert.equal(rows.length, 0);
  });

  it('group drag moves multiple nodes', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0], ['c', 50, 80]]);
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    sel = toggleSelection(sel, 'c');

    const drag = startDrag('a', pm, sel, true);
    assert.ok(drag.isGroup);
    assert.equal(drag.offsets.size, 2);

    onDrag(drag, 10, 10, pm);
    // b should be at original offset from a (100, 0) + delta (10, 10)
    assert.equal(pm.positions.get('b').x, 110);
    assert.equal(pm.positions.get('b').y, 10);

    const rows = endDrag(drag, pm);
    assert.equal(rows.length, 3); // a + b + c
  });

  it('draggedNodes returns all affected ids', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0]]);
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    const drag = startDrag('a', pm, sel, true);
    const ids = draggedNodes(drag);
    assert.ok(ids.has('a'));
    assert.ok(ids.has('b'));
  });

  it('locked nodes excluded from group drag offsets', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0]]);
    pm.positions.get('b').locked = true;
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    const drag = startDrag('a', pm, sel, true);
    assert.equal(drag.offsets.size, 0); // b is locked, not in offsets
  });
});

// ─────────────────────────────────────────────────
// Keyboard
// ─────────────────────────────────────────────────

describe('interact/keyboard', () => {
  it('X key starts reset mode', () => {
    const ks = createKeyState();
    const action = keyDown(ks, 'x', {});
    assert.equal(action.action, 'reset-start');
    assert.equal(ks.activeMode, 'reset');
  });

  it('X release stops reset mode', () => {
    const ks = createKeyState();
    keyDown(ks, 'x', {});
    const action = keyUp(ks, 'x');
    assert.equal(action.action, 'reset-stop');
    assert.equal(ks.activeMode, null);
  });

  it('Z key starts time-travel mode', () => {
    const ks = createKeyState();
    const action = keyDown(ks, 'z', {});
    assert.equal(action.action, 'time-travel-start');
    assert.equal(ks.activeMode, 'time-travel');
  });

  it('Space starts gather mode', () => {
    const ks = createKeyState();
    const action = keyDown(ks, ' ', {});
    assert.equal(action.action, 'gather-start');
    assert.equal(ks.activeMode, 'gather');
  });

  it('only one position mode at a time', () => {
    const ks = createKeyState();
    keyDown(ks, 'x', {}); // takes reset mode
    const action = keyDown(ks, 'z', {}); // should be blocked
    assert.equal(action, null);
    assert.equal(ks.activeMode, 'reset');
  });

  it('Escape clears active mode', () => {
    const ks = createKeyState();
    keyDown(ks, 'x', {});
    const action = keyDown(ks, 'escape', {});
    assert.equal(action.action, 'escape');
    assert.equal(ks.activeMode, null);
  });

  it('T+B sends trace backward', () => {
    const ks = createKeyState();
    keyDown(ks, 't', {});
    const action = keyDown(ks, 'b', {});
    assert.equal(action.action, 'trace-direction');
    assert.equal(action.direction, 'backward');
  });

  it('Alt+Arrow sends time-step', () => {
    const ks = createKeyState();
    const action = keyDown(ks, 'arrowleft', { alt: true });
    assert.equal(action.action, 'time-step');
    assert.equal(action.delta, -1);
  });

  it('Enter sends create-cluster', () => {
    const ks = createKeyState();
    const action = keyDown(ks, 'enter', {});
    assert.equal(action.action, 'create-cluster');
  });

  it('setPointerDepth updates depth', () => {
    const ks = createKeyState();
    setPointerDepth(ks, 3);
    assert.equal(ks.pointerDepth, 3);
  });

  it('isPositionModeBusy reflects active mode', () => {
    const ks = createKeyState();
    assert.ok(!isPositionModeBusy(ks));
    keyDown(ks, 'x', {});
    assert.ok(isPositionModeBusy(ks));
  });

  it('clearActiveMode resets everything', () => {
    const ks = createKeyState();
    keyDown(ks, 'x', {});
    clearActiveMode(ks);
    assert.equal(ks.activeMode, null);
    assert.equal(ks.held.size, 0);
  });
});

// ─────────────────────────────────────────────────
// Reset
// ─────────────────────────────────────────────────

describe('interact/reset', () => {
  it('startReset creates active state', () => {
    const rs = startReset(false);
    assert.ok(rs.active);
    assert.ok(!rs.ctrlOnly);
  });

  it('startReset with ctrl creates ctrlOnly state', () => {
    const rs = startReset(true);
    assert.ok(rs.ctrlOnly);
  });

  it('updateReset moves nodes toward T0', () => {
    const pm = makePosMap([['a', 100, 100]]);
    // T0 is (100,100), move it away
    pm.positions.get('a').x = 200;
    pm.positions.get('a').y = 200;

    const rs = startReset(false);
    const moved = updateReset(rs, 500, pm);

    assert.ok(moved.length > 0);
    // Should have moved toward T0 (100,100)
    assert.ok(pm.positions.get('a').x < 200);
    assert.ok(pm.positions.get('a').y < 200);
  });

  it('updateReset skips locked nodes', () => {
    const pm = makePosMap([['a', 100, 100]]);
    pm.positions.get('a').x = 200;
    pm.positions.get('a').locked = true;

    const rs = startReset(false);
    const moved = updateReset(rs, 500, pm);

    assert.equal(moved.length, 0);
    assert.equal(pm.positions.get('a').x, 200);
  });

  it('updateReset does nothing in ctrlOnly mode', () => {
    const pm = makePosMap([['a', 100, 100]]);
    pm.positions.get('a').x = 200;

    const rs = startReset(true);
    const moved = updateReset(rs, 500, pm);
    assert.equal(moved.length, 0);
  });

  it('resetSingleNode snaps to T0', () => {
    const pm = makePosMap([['a', 50, 60]]);
    pm.positions.get('a').x = 200;
    pm.positions.get('a').y = 300;

    const row = resetSingleNode('a', pm);
    assert.ok(row);
    assert.equal(pm.positions.get('a').x, 50);
    assert.equal(pm.positions.get('a').y, 60);
  });

  it('resetSingleNode returns null for locked node', () => {
    const pm = makePosMap([['a', 50, 60]]);
    pm.positions.get('a').locked = true;
    const row = resetSingleNode('a', pm);
    assert.equal(row, null);
  });
});

// ─────────────────────────────────────────────────
// Time Travel
// ─────────────────────────────────────────────────

describe('interact/time-travel', () => {
  function buildHistory() {
    const h = createHistory();
    for (let i = 0; i < 10; i++) {
      append(h, { type: 'NODE', op: 'add', id: `n${i}`, kind: 'function', label: `n${i}` });
    }
    return h;
  }

  it('startTimeTravel creates active state', () => {
    const tt = startTimeTravel(false);
    assert.ok(tt.active);
    assert.equal(tt.direction, -1);
  });

  it('startTimeTravel with shift creates fast state', () => {
    const tt = startTimeTravel(true);
    assert.ok(tt.fast);
    assert.ok(tt.stepInterval < 200);
  });

  it('updateTimeTravel steps backward over time', () => {
    const h = buildHistory();
    assert.equal(h.cursor, 9);

    const tt = startTimeTravel(false);
    // Simulate enough time to trigger a step
    const result = updateTimeTravel(tt, 250, h);
    assert.ok(result.stepped);
    assert.ok(result.newCursor < 9);
  });

  it('stopTimeTravel deactivates', () => {
    const tt = startTimeTravel(false);
    stopTimeTravel(tt);
    assert.ok(!tt.active);
  });

  it('stepOnce moves cursor by delta', () => {
    const h = buildHistory();
    const pos = stepOnce(h, -1);
    assert.equal(pos, 8);
  });

  it('timeTravelStatus reflects state', () => {
    const h = buildHistory();
    const status = timeTravelStatus(h);
    assert.equal(status.cursor, 9);
    assert.equal(status.total, 10);
    assert.equal(status.branch, 'main');
    assert.ok(status.atEnd);
  });

  it('stepOnce clamps at boundaries', () => {
    const h = buildHistory();
    // Step way back
    for (let i = 0; i < 20; i++) stepOnce(h, -1);
    assert.ok(h.cursor >= -1);
    // Step way forward
    for (let i = 0; i < 20; i++) stepOnce(h, 1);
    assert.equal(h.cursor, 9);
  });
});

// ─────────────────────────────────────────────────
// Gather
// ─────────────────────────────────────────────────

describe('interact/gather', () => {
  it('centroid computes average', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0], ['c', 0, 100]]);
    const c = centroid(new Set(['a', 'b', 'c']), pm);
    assert.ok(Math.abs(c.x - 100/3) < 0.01);
    assert.ok(Math.abs(c.y - 100/3) < 0.01);
  });

  it('startGather returns null with < 2 selected', () => {
    const pm = makePosMap([['a', 0, 0]]);
    const sel = selectNode(createSelection(), 'a');
    assert.equal(startGather(sel, pm), null);
  });

  it('startGather creates state for 2+ selected', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0]]);
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    const g = startGather(sel, pm);
    assert.ok(g);
    assert.equal(g.mode, 'centroid');
    assert.equal(g.pulledIds.size, 2);
  });

  it('updateGather moves nodes toward target', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 200, 0]]);
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    const g = startGather(sel, pm);

    const moved = updateGather(g, 100, pm);
    assert.ok(moved.length > 0);
    // b should have moved toward centroid (100, 0)
    assert.ok(pm.positions.get('b').x < 200);
  });

  it('updateGather skips locked nodes', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 200, 0]]);
    pm.positions.get('b').locked = true;
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    const g = startGather(sel, pm);
    const moved = updateGather(g, 100, pm);
    assert.ok(!moved.includes('b'));
    assert.equal(pm.positions.get('b').x, 200);
  });

  it('startStrangerGather pulls unselected neighbors', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0], ['c', -100, 0]]);
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'a', 'c'),
    );
    const sel = selectNode(createSelection(), 'a');
    const g = startStrangerGather('a', edges, sel, pm);
    assert.ok(g);
    assert.ok(g.pulledIds.has('b'));
    assert.ok(g.pulledIds.has('c'));
    assert.ok(!g.pulledIds.has('a'));
  });

  it('startGroupGather pulls selected toward anchor', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0], ['c', -100, 0]]);
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    sel = toggleSelection(sel, 'c');
    const g = startGroupGather('a', sel, pm);
    assert.ok(g);
    assert.ok(g.pulledIds.has('b'));
    assert.ok(g.pulledIds.has('c'));
    assert.ok(!g.pulledIds.has('a')); // anchor not pulled
  });

  it('startClusterGather pulls members toward cluster centroid', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0], ['c', 50, 80]]);
    const cluster = { id: 'c1', members: new Set(['a', 'b', 'c']), sourceHyperEdge: 'he1' };
    const g = startClusterGather(cluster, pm);
    assert.ok(g);
    assert.equal(g.mode, 'cluster');
    assert.equal(g.pulledIds.size, 3);
  });

  it('stopGather deactivates', () => {
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0]]);
    let sel = selectNode(createSelection(), 'a');
    sel = toggleSelection(sel, 'b');
    const g = startGather(sel, pm);
    stopGather(g);
    assert.ok(!g.active);
  });
});

// ─────────────────────────────────────────────────
// Attractor
// ─────────────────────────────────────────────────

describe('interact/attractor', () => {
  it('bfsNeighbors finds depth-1 neighbors', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
      makeEdge('e3', 'c', 'd'),
    );
    const neighbors = bfsNeighbors('a', edges, 1);
    assert.ok(neighbors.has('b'));
    assert.ok(!neighbors.has('c'));
    assert.ok(!neighbors.has('a'));
  });

  it('bfsNeighbors finds deeper neighbors', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
      makeEdge('e3', 'c', 'd'),
    );
    const neighbors = bfsNeighbors('a', edges, 3);
    assert.ok(neighbors.has('b'));
    assert.ok(neighbors.has('c'));
    assert.ok(neighbors.has('d'));
  });

  it('startAttractor returns null for unknown node', () => {
    const edges = makeEdgeMap();
    const pm = makePosMap([]);
    assert.equal(startAttractor('z', edges, pm), null);
  });

  it('startAttractor initializes with depth-1 neighbors', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'a', 'c'),
    );
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0], ['c', -100, 0]]);
    const att = startAttractor('a', edges, pm);
    assert.ok(att);
    assert.ok(att.pulled.has('b'));
    assert.ok(att.pulled.has('c'));
    assert.equal(att.maxDepth, 1);
  });

  it('updateAttractor pulls neighbors toward focal', () => {
    const edges = makeEdgeMap(makeEdge('e1', 'a', 'b'));
    const pm = makePosMap([['a', 0, 0], ['b', 200, 0]]);
    const att = startAttractor('a', edges, pm);

    updateAttractor(att, 100, edges, pm);
    assert.ok(pm.positions.get('b').x < 200);
  });

  it('updateAttractor ramps strength over time', () => {
    const edges = makeEdgeMap(makeEdge('e1', 'a', 'b'));
    const pm = makePosMap([['a', 0, 0], ['b', 200, 0]]);
    const att = startAttractor('a', edges, pm);

    updateAttractor(att, 1000, edges, pm);
    assert.ok(att.strength > 1.0);
  });

  it('updateAttractor expands BFS depth over time', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
    );
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0], ['c', 200, 0]]);
    const att = startAttractor('a', edges, pm);
    assert.ok(!att.pulled.has('c')); // depth 1 only

    // Simulate 1 second — should expand to depth 2
    updateAttractor(att, 1000, edges, pm);
    assert.ok(att.pulled.has('c'));
  });

  it('stopAttractor locks pulled nodes', () => {
    const edges = makeEdgeMap(makeEdge('e1', 'a', 'b'));
    const pm = makePosMap([['a', 0, 0], ['b', 100, 0]]);
    const att = startAttractor('a', edges, pm);

    const pulled = stopAttractor(att, pm);
    assert.ok(pulled.includes('b'));
    assert.ok(pm.positions.get('b').locked);
  });
});

// ─────────────────────────────────────────────────
// Trace
// ─────────────────────────────────────────────────

describe('interact/trace', () => {
  const ctx = createContext();

  it('buildAdjacency creates neighbor lists', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
    );
    const adj = buildAdjacency(edges, ctx);
    assert.ok(adj.has('a'));
    const aNeighbors = adj.get('a');
    assert.ok(aNeighbors.some(n => n.neighbor === 'b'));
  });

  it('buildAdjacency skips edges not in lens', () => {
    const narrowCtx = createContext();
    narrowCtx.lensEdgeLayers.clear();
    narrowCtx.lensEdgeLayers.add('memberOf');

    const edges = makeEdgeMap(makeEdge('e1', 'a', 'b', 'calls'));
    const adj = buildAdjacency(edges, narrowCtx);
    assert.equal(adj.size, 0);
  });

  it('computeBFS produces wavefronts', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
      makeEdge('e3', 'c', 'd'),
    );
    const adj = buildAdjacency(edges, ctx);
    const { wavefronts, visited } = computeBFS('a', adj, 'both');

    assert.equal(wavefronts.length, 4); // a, b, c, d
    assert.deepEqual(wavefronts[0], ['a']);
    assert.equal(visited.get('a'), 0);
    assert.equal(visited.get('d'), 3);
  });

  it('computeBFS respects forward direction', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'c', 'a'), // c -> a, so forward from a doesn't reach c
    );
    const adj = buildAdjacency(edges, ctx);
    const { visited } = computeBFS('a', adj, 'forward');

    assert.ok(visited.has('b'));
    assert.ok(!visited.has('c')); // c -> a is backward from a's perspective
  });

  it('computeBFS respects backward direction', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'), // forward a->b
      makeEdge('e2', 'c', 'a'), // c->a, backward from a reaches c
    );
    const adj = buildAdjacency(edges, ctx);
    const { visited } = computeBFS('a', adj, 'backward');

    assert.ok(!visited.has('b')); // a->b is forward
    assert.ok(visited.has('c'));  // c->a is backward from a
  });

  it('startTrace creates held trace state', () => {
    const edges = makeEdgeMap(makeEdge('e1', 'a', 'b'));
    const trace = startTrace('a', edges, ctx);
    assert.ok(trace.active);
    assert.equal(trace.sourceId, 'a');
    assert.equal(trace.currentWave, 0);
    assert.ok(!trace.complete);
  });

  it('flashTrace reveals everything instantly', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
    );
    const trace = flashTrace('a', edges, ctx);
    assert.ok(trace.complete);
    assert.equal(trace.currentWave, trace.wavefronts.length - 1);

    const nodes = revealedNodes(trace);
    assert.ok(nodes.has('a'));
    assert.ok(nodes.has('b'));
    assert.ok(nodes.has('c'));
  });

  it('updateTrace advances wavefront over time', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
    );
    const trace = startTrace('a', edges, ctx);
    assert.equal(trace.currentWave, 0);

    // Simulate enough time to advance
    const advanced = updateTrace(trace, 1100);
    assert.ok(advanced);
    assert.ok(trace.currentWave > 0);
  });

  it('holdTrace sets held flag', () => {
    const edges = makeEdgeMap(makeEdge('e1', 'a', 'b'));
    const trace = startTrace('a', edges, ctx);
    holdTrace(trace);
    assert.ok(trace.held);
  });

  it('releaseTrace deactivates', () => {
    const edges = makeEdgeMap(makeEdge('e1', 'a', 'b'));
    const trace = startTrace('a', edges, ctx);
    releaseTrace(trace);
    assert.ok(!trace.active);
  });

  it('revealedEdges returns traversed edges', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
    );
    const trace = flashTrace('a', edges, ctx);
    const re = revealedEdges(trace);
    assert.ok(re.has('e1'));
    assert.ok(re.has('e2'));
  });

  it('visibleNodes filter limits BFS scope', () => {
    const edges = makeEdgeMap(
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
      makeEdge('e3', 'c', 'd'),
    );
    const visible = new Set(['a', 'b', 'c']); // d is off-screen
    const trace = flashTrace('a', edges, ctx, visible);
    const nodes = revealedNodes(trace);
    assert.ok(nodes.has('c'));
    assert.ok(!nodes.has('d'));
  });
});
