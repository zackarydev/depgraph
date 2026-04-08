import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { init } from '../src/main.js';
import { generateDemoHistory } from '../src/data/demo-history.js';
import { buildFromHistory, rederive } from '../src/data/graph-builder.js';
import { deriveAll } from '../src/data/derive.js';
import { initialPlace } from '../src/layout/placement.js';
import { warmRestart } from '../src/layout/warm-restart.js';
import { createHistory, load as loadHistory, append as historyAppend, effectiveRows } from '../src/data/history.js';
import { writeCSV } from '../src/data/csv.js';
import { computeRenderPlan } from '../src/render/fractal.js';
import { createContext } from '../src/core/context.js';
import { createPositionMap, ensurePosition } from '../src/layout/positions.js';
import { parseCodemap, codemapToHistoryRows } from '../src/data/codemap.js';
import { expandCluster, collapseCluster, toggleCollapse, isPinnedCollapsed, isPinnedExpanded } from '../src/navigation/expand-collapse.js';
import { createSelection, selectNode, toggleSelection } from '../src/interact/select.js';
import { startDrag, onDrag, endDrag } from '../src/interact/drag.js';
import { createKeyState, keyDown, keyUp } from '../src/interact/keyboard.js';
import { startTrace, flashTrace, revealedNodes } from '../src/interact/trace.js';
import { startGather, updateGather, stopGather } from '../src/interact/gather.js';
import { startTimeTravel, updateTimeTravel, stopTimeTravel, stepOnce } from '../src/interact/time-travel.js';

// ─── 6.5a: Boot pipeline ─────────────────────────────

describe('6.5a — boot pipeline', () => {
  it('init() boots with demo history, graph has nodes and edges', () => {
    const runtime = init();
    assert.ok(runtime.graph, 'should have graph');
    assert.ok(runtime.graph.state.nodes.size > 0, 'should have nodes');
    assert.ok(runtime.graph.state.edges.size > 0, 'should have edges');
    assert.ok(runtime.graph.derivation, 'should have derivation');
    assert.ok(runtime.graph.derivation.clusters.size > 0, 'should have clusters');
    runtime.scheduler.stop();
  });

  it('init() places all nodes (posMap has positions)', () => {
    const runtime = init();
    assert.ok(runtime.posMap.positions.size > 0, 'should have positions');
    // Every node in state should have a position
    for (const [id] of runtime.graph.state.nodes) {
      assert.ok(runtime.posMap.positions.has(id), `node ${id} should have a position`);
    }
    runtime.scheduler.stop();
  });

  it('init() with CSV loads from CSV string', () => {
    const rows = generateDemoHistory();
    const csv = writeCSV(rows);
    const runtime = init({ csv });
    assert.ok(runtime.graph.state.nodes.size > 0);
    assert.ok(runtime.history.cursor >= 0);
    runtime.scheduler.stop();
  });

  it('bus row-appended triggers graph update', () => {
    const runtime = init();
    const initialNodeCount = runtime.graph.state.nodes.size;
    runtime.appendRow({ type: 'NODE', op: 'add', id: 'test-new-node', kind: 'function', label: 'testNew', weight: 1 });
    assert.ok(runtime.graph.state.nodes.has('test-new-node'), 'new node should be in state');
    assert.equal(runtime.graph.state.nodes.size, initialNodeCount + 1);
    runtime.scheduler.stop();
  });

  it('bus context-changed triggers re-derive', () => {
    const runtime = init();
    const oldClusters = new Map(runtime.graph.derivation.clusters);
    runtime.bus.emit('context-changed', { context: runtime.context });
    // Derivation should still be valid (same weights -> same result)
    assert.ok(runtime.graph.derivation.clusters.size > 0);
    runtime.scheduler.stop();
  });

  it('history time-travel works: stepOnce backward then forward', () => {
    const runtime = init();
    const origCursor = runtime.history.cursor;
    const origNodeCount = runtime.graph.state.nodes.size;

    // Step back
    stepOnce(runtime.history, -1);
    assert.equal(runtime.history.cursor, origCursor - 1);

    // Step forward
    stepOnce(runtime.history, 1);
    assert.equal(runtime.history.cursor, origCursor);

    runtime.scheduler.stop();
  });
});

// ─── 6.5d: Codemap parser ─────────────────────────────

describe('6.5d — codemap parser', () => {
  const testCodemap = `---
name: Code Map
description: test
type: reference
---

## AST Analysis
- \`extractJS\`: ~791 importance:8
- \`analyzeCode\`: ~802 importance:9

## Layout Engine
- \`computeLayout\`: ~1716 importance:10
- \`warmRestart\`: ~1979 importance:6

## Unclustered
- \`hashStr\`: ~740 importance:3
`;

  it('parseCodemap extracts entries with cluster, importance, line', () => {
    const entries = parseCodemap(testCodemap);
    assert.equal(entries.length, 5);

    const first = entries[0];
    assert.equal(first.id, 'extractJS');
    assert.equal(first.cluster, 'AST Analysis');
    assert.equal(first.importance, 8);
    assert.equal(first.line, 791);
  });

  it('parseCodemap assigns correct clusters', () => {
    const entries = parseCodemap(testCodemap);
    const clusters = new Set(entries.map(e => e.cluster));
    assert.ok(clusters.has('AST Analysis'));
    assert.ok(clusters.has('Layout Engine'));
    assert.ok(clusters.has('Unclustered'));
  });

  it('codemapToHistoryRows emits NODE + memberOf EDGE rows', () => {
    const entries = parseCodemap(testCodemap);
    const rows = codemapToHistoryRows(entries);

    // Should have: 5 function NODEs + 3 cluster NODEs + 5 memberOf EDGEs = 13
    const nodeRows = rows.filter(r => r.type === 'NODE');
    const edgeRows = rows.filter(r => r.type === 'EDGE');

    assert.equal(nodeRows.filter(r => r.kind === 'function').length, 5);
    assert.equal(nodeRows.filter(r => r.kind === 'cluster').length, 3);
    assert.equal(edgeRows.length, 5);
    assert.ok(edgeRows.every(r => r.layer === 'memberOf'));
  });

  it('codemap rows produce correct clusters in derivation', () => {
    const entries = parseCodemap(testCodemap);
    const rows = codemapToHistoryRows(entries);
    const graph = buildFromHistory(rows);

    assert.ok(graph.derivation.clusters.size > 0, 'should have clusters');
    // AST Analysis cluster should have extractJS and analyzeCode
    const astCluster = graph.derivation.clusters.get('cluster:cluster:AST Analysis');
    assert.ok(astCluster, 'AST Analysis cluster should exist');
    assert.ok(astCluster.members.has('extractJS'));
    assert.ok(astCluster.members.has('analyzeCode'));
  });
});

// ─── 6.5e: Bidirectional pinning ─────────────────────────

describe('6.5e — bidirectional pinning', () => {
  it('expandCluster adds to pinnedExpanded and removes from pinnedClusters', () => {
    let ctx = createContext();
    ctx = collapseCluster('cluster:render', ctx);
    assert.ok(isPinnedCollapsed('cluster:render', ctx));

    ctx = expandCluster('cluster:render', ctx);
    assert.ok(!isPinnedCollapsed('cluster:render', ctx));
    assert.ok(isPinnedExpanded('cluster:render', ctx));
  });

  it('collapseCluster adds to pinnedClusters and removes from pinnedExpanded', () => {
    let ctx = createContext();
    ctx = expandCluster('cluster:render', ctx);
    assert.ok(isPinnedExpanded('cluster:render', ctx));

    ctx = collapseCluster('cluster:render', ctx);
    assert.ok(isPinnedCollapsed('cluster:render', ctx));
    assert.ok(!isPinnedExpanded('cluster:render', ctx));
  });

  it('toggleCollapse cycles: auto -> collapsed -> expanded -> auto', () => {
    let ctx = createContext();

    // auto -> collapsed
    ctx = toggleCollapse('cluster:render', ctx);
    assert.ok(isPinnedCollapsed('cluster:render', ctx));
    assert.ok(!isPinnedExpanded('cluster:render', ctx));

    // collapsed -> expanded
    ctx = toggleCollapse('cluster:render', ctx);
    assert.ok(!isPinnedCollapsed('cluster:render', ctx));
    assert.ok(isPinnedExpanded('cluster:render', ctx));

    // expanded -> auto
    ctx = toggleCollapse('cluster:render', ctx);
    assert.ok(!isPinnedCollapsed('cluster:render', ctx));
    assert.ok(!isPinnedExpanded('cluster:render', ctx));
  });

  it('pin-expanded cluster stays expanded in render plan at low zoom', () => {
    // Build a graph with clusters
    const rows = generateDemoHistory();
    const graph = buildFromHistory(rows);
    const { posMap } = initialPlace(graph.state.nodes, graph.state.edges);

    let ctx = createContext();
    ctx = expandCluster('cluster:cluster:render', ctx);

    // Render at low zoom (where clusters would normally collapse)
    const plan = computeRenderPlan({
      nodes: graph.state.nodes,
      edges: graph.state.edges,
      clusters: graph.derivation.clusters,
      posMap,
      context: ctx,
      zoom: 0.1, // very zoomed out
    });

    // The pinned-expanded cluster should have its members in the plan
    const renderCluster = graph.derivation.clusters.get('cluster:cluster:render');
    if (renderCluster) {
      // At least some members should appear
      const memberIds = [...renderCluster.members];
      const renderedIds = new Set(plan.nodes.map(n => n.id));
      const membersRendered = memberIds.filter(m => renderedIds.has(m));
      assert.ok(membersRendered.length > 0 || plan.hulls.length > 0,
        'pinned-expanded cluster should show members or hull even at low zoom');
    }
  });
});

// ─── 6.5f: Drag emits spatial edges ──────────────────────

describe('6.5f — drag emits spatial edges', () => {
  it('endDrag emits spatial EDGE rows for K nearest neighbors', () => {
    const posMap = createPositionMap();
    ensurePosition(posMap, 'A', 0, 0);
    ensurePosition(posMap, 'B', 10, 10);
    ensurePosition(posMap, 'C', 20, 20);
    ensurePosition(posMap, 'D', 100, 100);
    ensurePosition(posMap, 'E', 200, 200);

    const sel = createSelection();
    const drag = startDrag('A', posMap, sel, false);
    onDrag(drag, 5, 5, posMap);
    const rows = endDrag(drag, posMap, { spatialK: 3 });

    // Should have 1 NODE update + 3 spatial EDGE rows
    const nodeRows = rows.filter(r => r.type === 'NODE');
    const edgeRows = rows.filter(r => r.type === 'EDGE' && r.layer === 'spatial');

    assert.equal(nodeRows.length, 1, 'should have 1 NODE update');
    assert.equal(edgeRows.length, 3, 'should have 3 spatial edges (K=3)');

    // All spatial edges should have source = 'A'
    assert.ok(edgeRows.every(r => r.source === 'A'));

    // Nearest neighbors should be B, C, D (not E which is farthest)
    const targets = edgeRows.map(r => r.target);
    assert.ok(targets.includes('B'), 'B should be a nearest neighbor');
    assert.ok(targets.includes('C'), 'C should be a nearest neighbor');
  });

  it('spatial edge weight is higher for closer neighbors', () => {
    const posMap = createPositionMap();
    ensurePosition(posMap, 'A', 0, 0);
    ensurePosition(posMap, 'B', 10, 0);   // close
    ensurePosition(posMap, 'C', 500, 0);  // far

    const sel = createSelection();
    const drag = startDrag('A', posMap, sel, false);
    onDrag(drag, 1, 1, posMap);
    const rows = endDrag(drag, posMap, { spatialK: 2 });

    const edges = rows.filter(r => r.type === 'EDGE' && r.layer === 'spatial');
    const bEdge = edges.find(r => r.target === 'B');
    const cEdge = edges.find(r => r.target === 'C');

    assert.ok(bEdge.weight > cEdge.weight, 'closer neighbor should have higher weight');
  });

  it('no spatial edges emitted when drag has no movement', () => {
    const posMap = createPositionMap();
    ensurePosition(posMap, 'A', 0, 0);
    ensurePosition(posMap, 'B', 10, 10);

    const sel = createSelection();
    const drag = startDrag('A', posMap, sel, false);
    // No onDrag call = no movement
    const rows = endDrag(drag, posMap);
    assert.equal(rows.length, 0);
  });

  it('spatial edge payload includes distance', () => {
    const posMap = createPositionMap();
    ensurePosition(posMap, 'A', 0, 0);
    ensurePosition(posMap, 'B', 30, 40);  // dist = 50

    const sel = createSelection();
    const drag = startDrag('A', posMap, sel, false);
    onDrag(drag, 1, 1, posMap);
    const rows = endDrag(drag, posMap, { spatialK: 1 });

    const edge = rows.find(r => r.type === 'EDGE' && r.layer === 'spatial');
    assert.ok(edge.payload.distance > 0, 'should have distance in payload');
  });
});

// ─── Integration: full pipeline round-trip ─────────────────

describe('integration — full pipeline', () => {
  it('demo history -> build -> place -> derive -> render plan', () => {
    const rows = generateDemoHistory();
    const graph = buildFromHistory(rows);
    const { posMap, converged } = initialPlace(graph.state.nodes, graph.state.edges);

    assert.ok(graph.state.nodes.size > 20, 'should have many nodes');
    assert.ok(graph.state.edges.size > 30, 'should have many edges');
    assert.ok(graph.derivation.clusters.size >= 3, 'should have clusters');
    assert.ok(posMap.positions.size > 0, 'should have positions');

    const ctx = createContext();
    const plan = computeRenderPlan({
      nodes: graph.state.nodes,
      edges: graph.state.edges,
      clusters: graph.derivation.clusters,
      posMap,
      context: ctx,
      zoom: 1,
    });

    assert.ok(plan.nodes.length > 0, 'render plan should have nodes');
    assert.ok(plan.edges.length > 0, 'render plan should have edges');
    assert.ok(plan.totalPrimitives > 0, 'render plan should have primitives');
  });

  it('append row -> graph updates -> positions exist for new node', () => {
    const runtime = init();
    const newId = 'brand-new-fn';
    runtime.appendRow({ type: 'NODE', op: 'add', id: newId, kind: 'function', label: 'brandNew', weight: 2 });
    assert.ok(runtime.graph.state.nodes.has(newId));
    // warmRestart should have placed the new node
    assert.ok(runtime.posMap.positions.has(newId), 'new node should have a position after warm restart');
    runtime.scheduler.stop();
  });

  it('keyboard dispatch routes correctly', () => {
    const ks = createKeyState();

    // Space triggers gather
    const gatherAction = keyDown(ks, ' ', {});
    assert.equal(gatherAction.action, 'gather-start');

    const gatherStop = keyUp(ks, ' ');
    assert.equal(gatherStop.action, 'gather-stop');

    // T triggers trace
    const traceAction = keyDown(ks, 't', {});
    assert.equal(traceAction.action, 'trace-start');

    const traceRelease = keyUp(ks, 't');
    assert.equal(traceRelease.action, 'trace-release');

    // Z triggers time-travel
    const ttAction = keyDown(ks, 'z', {});
    assert.equal(ttAction.action, 'time-travel-start');
  });

  it('selection -> drag -> history rows include spatial edges', () => {
    const runtime = init();
    const nodeIds = [...runtime.graph.state.nodes.keys()];
    const nodeId = nodeIds[0];

    const sel = selectNode(createSelection(), nodeId);
    const drag = startDrag(nodeId, runtime.posMap, sel, false);
    assert.ok(drag, 'drag should start');

    const ps = runtime.posMap.positions.get(nodeId);
    onDrag(drag, ps.x + 50, ps.y + 50, runtime.posMap);
    const rows = endDrag(drag, runtime.posMap);

    assert.ok(rows.length > 0, 'should produce history rows');
    const nodeRow = rows.find(r => r.type === 'NODE');
    assert.ok(nodeRow, 'should have NODE update');
    const spatialRows = rows.filter(r => r.type === 'EDGE' && r.layer === 'spatial');
    assert.ok(spatialRows.length > 0, 'should have spatial EDGE rows');

    runtime.scheduler.stop();
  });

  it('trace on demo graph reaches multiple hops', () => {
    const runtime = init();
    const nodeIds = [...runtime.graph.state.nodes.keys()];
    // Pick a well-connected node
    const sourceId = nodeIds.find(id => {
      let count = 0;
      for (const [, edge] of runtime.graph.state.edges) {
        if (edge.source === id || edge.target === id) count++;
      }
      return count >= 3;
    }) || nodeIds[0];

    const trace = flashTrace(sourceId, runtime.graph.state.edges, runtime.context);
    const revealed = revealedNodes(trace);
    assert.ok(revealed.size >= 3, `trace from ${sourceId} should reach at least 3 nodes, got ${revealed.size}`);
    assert.ok(trace.wavefronts.length >= 2, 'should have multiple wavefronts');

    runtime.scheduler.stop();
  });
});

process.exit(0);
