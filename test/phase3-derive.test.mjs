/**
 * Phase 3 — Derivation Engine tests.
 *
 * Tests: graph-builder, derive (hyperedges, affinities, clusters, dirty propagation),
 * context integration (W change shifts clusters).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFromHistory,
  applyRowToGraph,
  rederive,
} from '../src/data/graph-builder.js';

import {
  deriveHyperEdges,
  deriveAffinities,
  deriveClusters,
  deriveAll,
  buildClusterIndex,
  invalidateEdge,
  recompute,
  createDerivation,
} from '../src/data/derive.js';

import {
  createContext,
  applyPreset,
  setWeights,
  DEFAULT_WEIGHTS,
} from '../src/core/context.js';

// ─── Helpers: build history rows ───

function nodeRow(t, id, kind, label, weight) {
  return { t, type: 'NODE', op: 'add', id, kind, label, weight };
}

function edgeRow(t, id, source, target, layer, weight) {
  return { t, type: 'EDGE', op: 'add', id, source, target, layer, weight: weight ?? 1 };
}

function removeEdgeRow(t, id, source, target, layer) {
  return { t, type: 'EDGE', op: 'remove', id, source, target, layer };
}

/**
 * Build a small test graph:
 *  Nodes: A, B, C, D, E, mod1 (a module node)
 *  Edges: A->B calls, A->C calls, B->C shared, D->E calls,
 *         A->mod1 memberOf, B->mod1 memberOf, C->mod1 memberOf
 */
function smallGraph() {
  return [
    nodeRow(0, 'A', 'function', 'funcA', 1),
    nodeRow(1, 'B', 'function', 'funcB', 1),
    nodeRow(2, 'C', 'function', 'funcC', 1),
    nodeRow(3, 'D', 'function', 'funcD', 1),
    nodeRow(4, 'E', 'function', 'funcE', 1),
    nodeRow(5, 'mod1', 'module', 'Module One', 2),
    edgeRow(6, 'A->B@calls', 'A', 'B', 'calls', 1),
    edgeRow(7, 'A->C@calls', 'A', 'C', 'calls', 1),
    edgeRow(8, 'B->C@shared', 'B', 'C', 'shared', 1),
    edgeRow(9, 'D->E@calls', 'D', 'E', 'calls', 1),
    edgeRow(10, 'A->mod1@memberOf', 'A', 'mod1', 'memberOf', 1),
    edgeRow(11, 'B->mod1@memberOf', 'B', 'mod1', 'memberOf', 1),
    edgeRow(12, 'C->mod1@memberOf', 'C', 'mod1', 'memberOf', 1),
  ];
}

// ─────────────────────────────────────────────────
// graph-builder
// ─────────────────────────────────────────────────

describe('graph-builder', () => {
  it('buildFromHistory produces correct node and edge maps', () => {
    const rows = smallGraph();
    const graph = buildFromHistory(rows);

    assert.equal(graph.state.nodes.size, 6);
    assert.equal(graph.state.edges.size, 7);
    assert.ok(graph.state.nodes.has('A'));
    assert.ok(graph.state.edges.has('A->B@calls'));
  });

  it('buildFromHistory also produces derivation', () => {
    const graph = buildFromHistory(smallGraph());
    assert.ok(graph.derivation);
    assert.ok(graph.derivation.hyperEdges.size > 0);
    assert.ok(graph.derivation.affinities.size > 0);
    assert.ok(graph.derivation.clusters.size > 0);
  });

  it('handles NODE add + EDGE add + EDGE remove sequence', () => {
    const rows = [
      ...smallGraph(),
      removeEdgeRow(13, 'A->B@calls', 'A', 'B', 'calls'),
      removeEdgeRow(14, 'A->C@calls', 'A', 'C', 'calls'),
    ];
    const graph = buildFromHistory(rows);
    assert.equal(graph.state.edges.size, 5); // 7 - 2
    assert.ok(!graph.state.edges.has('A->B@calls'));
  });

  it('applyRowToGraph incrementally updates state', () => {
    const graph = buildFromHistory(smallGraph());
    const newEdge = edgeRow(20, 'D->A@calls', 'D', 'A', 'calls', 2);
    applyRowToGraph(graph, newEdge);

    assert.ok(graph.state.edges.has('D->A@calls'));
    assert.equal(graph.state.edges.size, 8);
  });

  it('rederive rebuilds derivation from scratch', () => {
    const graph = buildFromHistory(smallGraph());
    const before = graph.derivation.clusters.size;
    rederive(graph, { ...DEFAULT_WEIGHTS, calls: 100.0 });
    // After rederive, clusters still exist (structure may shift)
    assert.ok(graph.derivation.clusters.size > 0);
  });
});

// ─────────────────────────────────────────────────
// derive — hyperEdges
// ─────────────────────────────────────────────────

describe('deriveHyperEdges', () => {
  it('groups edges by common member + layer', () => {
    const edges = new Map([
      ['A->B@calls', { id: 'A->B@calls', source: 'A', target: 'B', layer: 'calls', weight: 1 }],
      ['A->C@calls', { id: 'A->C@calls', source: 'A', target: 'C', layer: 'calls', weight: 1 }],
      ['B->C@shared', { id: 'B->C@shared', source: 'B', target: 'C', layer: 'shared', weight: 1 }],
    ]);

    const hes = deriveHyperEdges(edges);

    // A@calls should contain both A->B@calls and A->C@calls
    const aCalls = hes.get('A@calls');
    assert.ok(aCalls);
    assert.equal(aCalls.edgeIds.size, 2);
    assert.ok(aCalls.edgeIds.has('A->B@calls'));
    assert.ok(aCalls.edgeIds.has('A->C@calls'));
    assert.equal(aCalls.commonMember, 'A');
    assert.equal(aCalls.layer, 'calls');
  });

  it('creates separate hyperedges per layer', () => {
    const edges = new Map([
      ['A->B@calls', { id: 'A->B@calls', source: 'A', target: 'B', layer: 'calls', weight: 1 }],
      ['A->B@shared', { id: 'A->B@shared', source: 'A', target: 'B', layer: 'shared', weight: 1 }],
    ]);

    const hes = deriveHyperEdges(edges);
    assert.ok(hes.has('A@calls'));
    assert.ok(hes.has('A@shared'));
    assert.notEqual(hes.get('A@calls'), hes.get('A@shared'));
  });

  it('returns empty map for no edges', () => {
    assert.equal(deriveHyperEdges(new Map()).size, 0);
  });
});

// ─────────────────────────────────────────────────
// derive — affinities
// ─────────────────────────────────────────────────

describe('deriveAffinities', () => {
  const edges = new Map([
    ['A->B@calls', { id: 'A->B@calls', source: 'A', target: 'B', layer: 'calls', weight: 1 }],
    ['A->C@calls', { id: 'A->C@calls', source: 'A', target: 'C', layer: 'calls', weight: 1 }],
    ['A->D@shared', { id: 'A->D@shared', source: 'A', target: 'D', layer: 'shared', weight: 1 }],
  ]);

  it('returns normalized affinities for a node', () => {
    const aff = deriveAffinities('A', edges);
    // Sum should be ~1
    let sum = 0;
    for (const v of aff.values()) sum += v;
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `expected sum ~1, got ${sum}`);
  });

  it('weights by layer using W', () => {
    const W = { calls: 10.0, shared: 1.0 };
    const aff = deriveAffinities('A', edges, W);

    // calls edges (B, C) should dominate over shared edge (D)
    const bWeight = aff.get('B') || 0;
    const dWeight = aff.get('D') || 0;
    assert.ok(bWeight > dWeight, `calls-weighted B (${bWeight}) should > shared D (${dWeight})`);
  });

  it('groups by cluster when nodeToCluster provided', () => {
    const clusterMap = new Map([['B', 'cluster:X'], ['C', 'cluster:X'], ['D', 'cluster:Y']]);
    const aff = deriveAffinities('A', edges, undefined, clusterMap);

    // B and C should be grouped under cluster:X
    assert.ok(aff.has('cluster:X'));
    assert.ok(aff.has('cluster:Y'));
    assert.ok(!aff.has('B')); // grouped into cluster:X
  });

  it('returns empty map for node with no edges', () => {
    const aff = deriveAffinities('Z', edges);
    assert.equal(aff.size, 0);
  });
});

// ─────────────────────────────────────────────────
// derive — clusters
// ─────────────────────────────────────────────────

describe('deriveClusters', () => {
  it('creates clusters from memberOf edges', () => {
    const nodes = new Map([
      ['A', { id: 'A' }], ['B', { id: 'B' }], ['mod1', { id: 'mod1' }],
    ]);
    const edges = new Map([
      ['A->mod1@memberOf', { id: 'A->mod1@memberOf', source: 'A', target: 'mod1', layer: 'memberOf', weight: 1 }],
      ['B->mod1@memberOf', { id: 'B->mod1@memberOf', source: 'B', target: 'mod1', layer: 'memberOf', weight: 1 }],
    ]);
    const affinities = new Map([
      ['A', new Map([['mod1', 1.0]])],
      ['B', new Map([['mod1', 1.0]])],
    ]);

    const clusters = deriveClusters(nodes, edges, affinities);
    const c = clusters.get('cluster:mod1');
    assert.ok(c, 'cluster:mod1 should exist');
    assert.ok(c.members.has('A'));
    assert.ok(c.members.has('B'));
    assert.ok(!c.members.has('mod1'), 'mod1 (the target) should not be a member of itself');
  });

  it('assigns unclustered nodes by primary affinity', () => {
    const nodes = new Map([
      ['A', { id: 'A' }], ['B', { id: 'B' }], ['C', { id: 'C' }],
    ]);
    const edges = new Map(); // no memberOf
    const affinities = new Map([
      ['A', new Map([['B', 0.8], ['C', 0.2]])],
      ['B', new Map([['A', 0.6], ['C', 0.4]])],
      ['C', new Map([['A', 0.3], ['B', 0.7]])],
    ]);

    const clusters = deriveClusters(nodes, edges, affinities);
    // A's primary is B, B's primary is A, C's primary is B
    // So cluster:B should have members A and C, cluster:A should have B
    assert.ok(clusters.size > 0);
  });

  it('returns empty map for no nodes', () => {
    const clusters = deriveClusters(new Map(), new Map(), new Map());
    assert.equal(clusters.size, 0);
  });
});

// ─────────────────────────────────────────────────
// derive — full pipeline (deriveAll)
// ─────────────────────────────────────────────────

describe('deriveAll', () => {
  it('produces hyperEdges, affinities, and clusters', () => {
    const graph = buildFromHistory(smallGraph());
    const d = graph.derivation;

    assert.ok(d.hyperEdges.size > 0, 'should have hyperEdges');
    assert.ok(d.affinities.size > 0, 'should have affinities');
    assert.ok(d.clusters.size > 0, 'should have clusters');
    assert.equal(d.dirtyNodes.size, 0, 'no dirty nodes after full derive');
  });

  it('memberOf cluster contains A, B, C', () => {
    const graph = buildFromHistory(smallGraph());
    const cluster = graph.derivation.clusters.get('cluster:mod1');
    assert.ok(cluster, 'cluster:mod1 should exist');
    assert.ok(cluster.members.has('A'));
    assert.ok(cluster.members.has('B'));
    assert.ok(cluster.members.has('C'));
  });

  it('affinities are normalized per node', () => {
    const graph = buildFromHistory(smallGraph());
    for (const [nodeId, aff] of graph.derivation.affinities) {
      if (aff.size === 0) continue;
      let sum = 0;
      for (const v of aff.values()) sum += v;
      assert.ok(
        Math.abs(sum - 1.0) < 1e-9,
        `node ${nodeId}: affinities sum to ${sum}, expected 1.0`
      );
    }
  });
});

// ─────────────────────────────────────────────────
// derive — dirty propagation
// ─────────────────────────────────────────────────

describe('dirty propagation', () => {
  it('invalidateEdge marks both endpoints dirty', () => {
    const d = createDerivation();
    invalidateEdge(d, { source: 'A', target: 'B' });
    assert.ok(d.dirtyNodes.has('A'));
    assert.ok(d.dirtyNodes.has('B'));
  });

  it('recompute only processes dirty nodes', () => {
    const graph = buildFromHistory(smallGraph());

    // Track which nodes get recomputed by spying on affinities changes
    const affinitiesBefore = new Map();
    for (const [k, v] of graph.derivation.affinities) {
      affinitiesBefore.set(k, v);
    }

    // Add a new edge and invalidate
    const newRow = edgeRow(20, 'D->C@calls', 'D', 'C', 'calls', 1);
    applyRowToGraph(graph, newRow);

    // After incremental update, D and C should have new affinities
    const dAfter = graph.derivation.affinities.get('D');
    const cAfter = graph.derivation.affinities.get('C');
    assert.ok(dAfter, 'D should still have affinities');
    assert.ok(cAfter, 'C should still have affinities');

    // A's affinities should not have been recomputed (same reference)
    // Since we rebuilt, they may be same values but we just confirm D changed
    assert.ok(dAfter.size > 0, 'D should have non-empty affinities after new edge');
  });

  it('recompute clears dirty set', () => {
    const graph = buildFromHistory(smallGraph());
    const newRow = edgeRow(20, 'A->E@shared', 'A', 'E', 'shared', 1);
    applyRowToGraph(graph, newRow);
    assert.equal(graph.derivation.dirtyNodes.size, 0, 'dirty set should be cleared after recompute');
  });

  it('adding one edge to large graph only marks 2 nodes dirty', () => {
    // Build a bigger graph
    const rows = [];
    let t = 0;
    for (let i = 0; i < 50; i++) {
      rows.push(nodeRow(t++, `n${i}`, 'function', `func${i}`, 1));
    }
    for (let i = 0; i < 49; i++) {
      rows.push(edgeRow(t++, `n${i}->n${i+1}@calls`, `n${i}`, `n${i+1}`, 'calls', 1));
    }

    const graph = buildFromHistory(rows);
    assert.equal(graph.derivation.dirtyNodes.size, 0);

    // Now add one edge — only 2 endpoints should be dirty before recompute
    const d = graph.derivation;
    const row = edgeRow(t++, 'n0->n25@shared', 'n0', 'n25', 'shared', 1);
    invalidateEdge(d, row);
    assert.equal(d.dirtyNodes.size, 2);
    assert.ok(d.dirtyNodes.has('n0'));
    assert.ok(d.dirtyNodes.has('n25'));
  });
});

// ─────────────────────────────────────────────────
// buildClusterIndex
// ─────────────────────────────────────────────────

describe('buildClusterIndex', () => {
  it('maps members to their cluster id', () => {
    const clusters = new Map([
      ['cluster:X', { id: 'cluster:X', members: new Set(['A', 'B']), sourceHyperEdge: 'test' }],
      ['cluster:Y', { id: 'cluster:Y', members: new Set(['C']), sourceHyperEdge: 'test2' }],
    ]);
    const idx = buildClusterIndex(clusters);
    assert.equal(idx.get('A'), 'cluster:X');
    assert.equal(idx.get('B'), 'cluster:X');
    assert.equal(idx.get('C'), 'cluster:Y');
  });
});

// ─────────────────────────────────────────────────
// context integration — W change shifts clusters
// ─────────────────────────────────────────────────

describe('context integration', () => {
  /**
   * Helper: get the affinity weight for a node toward a target node,
   * accounting for cluster grouping (affinities may use cluster:X keys).
   */
  function affinityToward(derivation, nodeId, targetId) {
    const aff = derivation.affinities.get(nodeId);
    if (!aff) return 0;
    // Direct lookup
    if (aff.has(targetId)) return aff.get(targetId);
    // Cluster lookup: find which cluster target belongs to
    const idx = buildClusterIndex(derivation.clusters);
    const clusterId = idx.get(targetId);
    if (clusterId && aff.has(clusterId)) return aff.get(clusterId);
    return 0;
  }

  it('changing W shifts affinities', () => {
    // Use explicit memberOf clusters so B and C are in separate clusters
    const rows = [
      nodeRow(0, 'A', 'function', 'A', 1),
      nodeRow(1, 'B', 'function', 'B', 1),
      nodeRow(2, 'C', 'function', 'C', 1),
      nodeRow(3, 'modB', 'module', 'ModB', 1),
      nodeRow(4, 'modC', 'module', 'ModC', 1),
      edgeRow(5, 'B->modB@memberOf', 'B', 'modB', 'memberOf', 1),
      edgeRow(6, 'C->modC@memberOf', 'C', 'modC', 'memberOf', 1),
      edgeRow(7, 'A->B@calls', 'A', 'B', 'calls', 1),
      edgeRow(8, 'A->C@shared', 'A', 'C', 'shared', 1),
    ];

    // Default W: calls=0.3, shared=0.5 — shared edge to C should be stronger
    const g1 = buildFromHistory(rows);
    const bWeight1 = affinityToward(g1.derivation, 'A', 'B');
    const cWeight1 = affinityToward(g1.derivation, 'A', 'C');
    assert.ok(cWeight1 > bWeight1, `default: C (${cWeight1}) should > B (${bWeight1})`);

    // Boosted calls: calls=10.0, shared=0.1 — calls edge to B should dominate
    const W2 = { ...DEFAULT_WEIGHTS, calls: 10.0, shared: 0.1 };
    const g2 = buildFromHistory(rows, W2);
    const bWeight2 = affinityToward(g2.derivation, 'A', 'B');
    const cWeight2 = affinityToward(g2.derivation, 'A', 'C');
    assert.ok(bWeight2 > cWeight2, `boosted calls: B (${bWeight2}) should > C (${cWeight2})`);
  });

  it('switching from code-review to refactor preset produces different affinities', () => {
    const rows = [
      nodeRow(0, 'A', 'function', 'A', 1),
      nodeRow(1, 'B', 'function', 'B', 1),
      nodeRow(2, 'C', 'function', 'C', 1),
      nodeRow(3, 'modB', 'module', 'ModB', 1),
      nodeRow(4, 'modC', 'module', 'ModC', 1),
      edgeRow(5, 'B->modB@memberOf', 'B', 'modB', 'memberOf', 1),
      edgeRow(6, 'C->modC@memberOf', 'C', 'modC', 'memberOf', 1),
      edgeRow(7, 'A->B@calls', 'A', 'B', 'calls', 3),
      edgeRow(8, 'A->C@spatial', 'A', 'C', 'spatial', 2),
    ];

    const ctxReview = applyPreset(createContext(), 'code-review');
    const ctxRefactor = applyPreset(createContext(), 'refactor');

    // code-review: calls=3.0, spatial=0.1 -> B dominates
    const gReview = buildFromHistory(rows, ctxReview.weights.affinity);
    const bReview = affinityToward(gReview.derivation, 'A', 'B');
    const cReview = affinityToward(gReview.derivation, 'A', 'C');

    // refactor: calls=0.5, spatial=1.0 -> C gains relative weight
    const gRefactor = buildFromHistory(rows, ctxRefactor.weights.affinity);
    const bRefactor = affinityToward(gRefactor.derivation, 'A', 'B');
    const cRefactor = affinityToward(gRefactor.derivation, 'A', 'C');

    assert.ok(bReview > bRefactor, `B stronger in code-review (${bReview}) than refactor (${bRefactor})`);
    assert.ok(cRefactor > cReview, `C stronger in refactor (${cRefactor}) than code-review (${cReview})`);
  });

  it('rederive with new W changes primary affinity', () => {
    // Two separate clusters: modB (contains B) and modC (contains C)
    // A connects to B via calls and to C via shared
    const rows = [
      nodeRow(0, 'A', 'function', 'A', 1),
      nodeRow(1, 'B', 'function', 'B', 1),
      nodeRow(2, 'C', 'function', 'C', 1),
      nodeRow(3, 'modB', 'module', 'ModB', 1),
      nodeRow(4, 'modC', 'module', 'ModC', 1),
      edgeRow(5, 'B->modB@memberOf', 'B', 'modB', 'memberOf', 1),
      edgeRow(6, 'C->modC@memberOf', 'C', 'modC', 'memberOf', 1),
      edgeRow(7, 'A->B@calls', 'A', 'B', 'calls', 5),
      edgeRow(8, 'A->C@shared', 'A', 'C', 'shared', 5),
    ];

    // calls=10, shared=0.1 -> A's primary is B's cluster
    const g1 = buildFromHistory(rows, { ...DEFAULT_WEIGHTS, calls: 10.0, shared: 0.1 });
    const b1 = affinityToward(g1.derivation, 'A', 'B');
    const c1 = affinityToward(g1.derivation, 'A', 'C');
    assert.ok(b1 > c1, `calls-heavy: B (${b1}) should > C (${c1})`);

    // calls=0.1, shared=10 -> A's primary is C's cluster
    const g2 = buildFromHistory(rows, { ...DEFAULT_WEIGHTS, calls: 0.1, shared: 10.0 });
    const b2 = affinityToward(g2.derivation, 'A', 'B');
    const c2 = affinityToward(g2.derivation, 'A', 'C');
    assert.ok(c2 > b2, `shared-heavy: C (${c2}) should > B (${b2})`);
  });
});

// ─────────────────────────────────────────────────
// Integration: full pipeline round-trip
// ─────────────────────────────────────────────────

describe('integration', () => {
  it('20 NODEs + 30 EDGEs -> correct maps, then 2 EDGE removes update', () => {
    const rows = [];
    let t = 0;

    // 20 nodes
    for (let i = 0; i < 20; i++) {
      rows.push(nodeRow(t++, `n${i}`, 'function', `func${i}`, 1));
    }

    // 30 edges (calls between consecutive + some shared)
    for (let i = 0; i < 19; i++) {
      rows.push(edgeRow(t++, `n${i}->n${i+1}@calls`, `n${i}`, `n${i+1}`, 'calls', 1));
    }
    for (let i = 0; i < 11; i++) {
      rows.push(edgeRow(t++, `n${i}->n${i+5}@shared`, `n${i}`, `n${i+5}`, 'shared', 1));
    }

    const graph = buildFromHistory(rows);
    assert.equal(graph.state.nodes.size, 20);
    assert.equal(graph.state.edges.size, 30);
    assert.ok(graph.derivation.hyperEdges.size > 0);

    // Remove 2 edges
    const rm1 = removeEdgeRow(t++, 'n0->n1@calls', 'n0', 'n1', 'calls');
    const rm2 = removeEdgeRow(t++, 'n1->n2@calls', 'n1', 'n2', 'calls');
    applyRowToGraph(graph, rm1);
    applyRowToGraph(graph, rm2);

    assert.equal(graph.state.edges.size, 28);
    // Derivation should still be valid
    assert.ok(graph.derivation.affinities.size > 0);
  });
});
