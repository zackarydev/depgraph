/**
 * Phase 5 — Rendering tests.
 *
 * Tests the pure-logic contracts: layers, visibility, opacity,
 * viewport culling, LOD, meta-edges, hull computation, render pump.
 * Browser-dependent SVG rendering is tested separately (test:visual).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDGE_LAYERS,
  ensureLayer,
  getLayer,
  setLayerVisible,
  pullLayerState,
  layerIds,
} from '../src/edges/layers.js';

import {
  isVisible,
  isEdgeVisible,
  isNodeVisible,
} from '../src/edges/visibility.js';

import { edgeOpacity } from '../src/edges/opacity.js';

import {
  queryVisible,
  screenRadius,
  lodLevel,
  computeExpansion,
} from '../src/render/viewport.js';

import {
  clusterCentroid,
  computeMetaEdges,
} from '../src/render/meta-edges.js';

import { computeHull, expandHull } from '../src/render/hulls.js';

import {
  getRenderCount,
  resetRenderCount,
  renderPositions,
} from '../src/render/positions.js';

import { LAYER_ORDER } from '../src/render/svg.js';

import { computeRenderPlan, planStats } from '../src/render/fractal.js';
import { computeLOD, lodDiff } from '../src/navigation/semantic-zoom.js';
import { expandCluster, collapseCluster, toggleCollapse, isPinnedCollapsed } from '../src/navigation/expand-collapse.js';

import { createContext, applyPreset } from '../src/core/context.js';
import { rebuild } from '../src/layout/quadtree.js';
import { createPositionMap, ensurePosition } from '../src/layout/positions.js';

// ─── Helpers ───

function makeEdge(id, source, target, layer, weight) {
  return { id, source, target, layer, weight: weight || 1, directed: true };
}

function makeContext(overrides) {
  const ctx = createContext();
  if (overrides) Object.assign(ctx, overrides);
  return ctx;
}

// ─────────────────────────────────────────────────
// Layers
// ─────────────────────────────────────────────────

describe('edges/layers', () => {
  it('has canonical layers registered', () => {
    assert.ok(EDGE_LAYERS.has('calls'));
    assert.ok(EDGE_LAYERS.has('memberOf'));
    assert.ok(EDGE_LAYERS.has('shared'));
    assert.ok(EDGE_LAYERS.size >= 10);
  });

  it('getLayer returns definition', () => {
    const def = getLayer('calls');
    assert.ok(def);
    assert.equal(def.id, 'calls');
    assert.ok(def.color);
    assert.equal(def.directed, true);
  });

  it('ensureLayer registers unknown layers', () => {
    const before = EDGE_LAYERS.size;
    const def = ensureLayer('custom-test-layer');
    assert.equal(def.id, 'custom-test-layer');
    assert.equal(def.color, '#888888');
    assert.ok(EDGE_LAYERS.has('custom-test-layer'));
    // Clean up
    EDGE_LAYERS.delete('custom-test-layer');
  });

  it('setLayerVisible toggles visibility', () => {
    const original = getLayer('calls').visible;
    setLayerVisible('calls', false);
    assert.equal(getLayer('calls').visible, false);
    setLayerVisible('calls', true);
    assert.equal(getLayer('calls').visible, true);
  });

  it('pullLayerState reflects context lens', () => {
    const ctx = makeContext();
    const state = pullLayerState(ctx);
    assert.ok(state.has('calls'));
    assert.equal(state.get('calls').visible, true);

    // Remove calls from lens
    ctx.lensEdgeLayers.delete('calls');
    const state2 = pullLayerState(ctx);
    assert.equal(state2.get('calls').visible, false);
    // Restore
    ctx.lensEdgeLayers.add('calls');
  });

  it('layerIds returns all registered layers', () => {
    const ids = layerIds();
    assert.ok(ids.includes('calls'));
    assert.ok(ids.includes('memberOf'));
  });
});

// ─────────────────────────────────────────────────
// Visibility
// ─────────────────────────────────────────────────

describe('edges/visibility', () => {
  it('edge is visible when its layer is in the lens', () => {
    const ctx = makeContext();
    const edge = makeEdge('e1', 'a', 'b', 'calls', 1);
    assert.ok(isEdgeVisible(edge, ctx));
  });

  it('edge is hidden when its layer is removed from lens', () => {
    const ctx = makeContext();
    ctx.lensEdgeLayers.delete('calls');
    const edge = makeEdge('e1', 'a', 'b', 'calls', 1);
    assert.ok(!isEdgeVisible(edge, ctx));
    ctx.lensEdgeLayers.add('calls');
  });

  it('edge is hidden when layer toggled off in registry', () => {
    const ctx = makeContext();
    setLayerVisible('calls', false);
    const edge = makeEdge('e1', 'a', 'b', 'calls', 1);
    assert.ok(!isEdgeVisible(edge, ctx));
    setLayerVisible('calls', true);
  });

  it('edge is hidden when opacity is 0', () => {
    const ctx = makeContext();
    ctx.weights.opacity.calls = 0;
    const edge = makeEdge('e1', 'a', 'b', 'calls', 1);
    assert.ok(!isEdgeVisible(edge, ctx));
    ctx.weights.opacity.calls = 1.0;
  });

  it('node is visible if any incident edge is on visible layer', () => {
    const ctx = makeContext();
    const edges = new Map([
      ['e1', makeEdge('e1', 'a', 'b', 'calls', 1)],
    ]);
    assert.ok(isNodeVisible('a', ctx, edges));
  });

  it('node is hidden if all incident edge layers removed from lens', () => {
    const ctx = makeContext();
    ctx.lensEdgeLayers.delete('calls');
    const edges = new Map([
      ['e1', makeEdge('e1', 'a', 'b', 'calls', 1)],
    ]);
    assert.ok(!isNodeVisible('a', ctx, edges));
    ctx.lensEdgeLayers.add('calls');
  });

  it('node is visible if in focal set even with no visible edges', () => {
    const ctx = makeContext();
    ctx.lensEdgeLayers.clear(); // remove all layers
    ctx.focalNodes.add('a');
    const edges = new Map([
      ['e1', makeEdge('e1', 'a', 'b', 'calls', 1)],
    ]);
    assert.ok(isNodeVisible('a', ctx, edges));
    // Restore
    for (const l of layerIds()) ctx.lensEdgeLayers.add(l);
    ctx.focalNodes.delete('a');
  });

  it('orphan node (no edges) is visible', () => {
    const ctx = makeContext();
    assert.ok(isNodeVisible('orphan', ctx, new Map()));
  });
});

// ─────────────────────────────────────────────────
// Opacity
// ─────────────────────────────────────────────────

describe('edges/opacity', () => {
  it('returns a value between 0 and 1', () => {
    const ctx = makeContext();
    const edge = makeEdge('e1', 'a', 'b', 'calls', 1);
    const op = edgeOpacity(edge, ctx);
    assert.ok(op >= 0 && op <= 1, `opacity ${op} should be in [0,1]`);
  });

  it('returns 0 when layer opacity is 0', () => {
    const ctx = makeContext();
    ctx.weights.opacity.calls = 0;
    const edge = makeEdge('e1', 'a', 'b', 'calls', 1);
    assert.equal(edgeOpacity(edge, ctx), 0);
    ctx.weights.opacity.calls = 1.0;
  });

  it('higher edge weight gives higher opacity', () => {
    const ctx = makeContext();
    const e1 = makeEdge('e1', 'a', 'b', 'calls', 1);
    const e5 = makeEdge('e5', 'a', 'b', 'calls', 5);
    assert.ok(edgeOpacity(e5, ctx) >= edgeOpacity(e1, ctx));
  });
});

// ─────────────────────────────────────────────────
// Viewport
// ─────────────────────────────────────────────────

describe('render/viewport', () => {
  it('queryVisible returns only points inside bounds + halo', () => {
    const points = [
      { id: 'a', x: 50, y: 50 },
      { id: 'b', x: 500, y: 500 },
      { id: 'c', x: 5000, y: 5000 },
    ];
    const tree = rebuild(points);
    const visible = queryVisible(tree, { x: 0, y: 0, width: 600, height: 600 }, 100);

    const ids = visible.map(p => p.id);
    assert.ok(ids.includes('a'));
    assert.ok(ids.includes('b'));
    assert.ok(!ids.includes('c'), 'c at (5000,5000) should be culled');
  });

  it('queryVisible with 5000 nodes returns subset when zoomed in', () => {
    const points = [];
    for (let i = 0; i < 5000; i++) {
      points.push({ id: `p${i}`, x: Math.random() * 10000 - 5000, y: Math.random() * 10000 - 5000 });
    }
    const tree = rebuild(points);
    // Small viewport: only 400x400 centered at origin
    const visible = queryVisible(tree, { x: -200, y: -200, width: 400, height: 400 }, 200);
    // Should be far fewer than 5000
    assert.ok(visible.length < 5000, `expected culling, got ${visible.length}/5000`);
    assert.ok(visible.length > 0, 'should have some visible nodes near origin');
  });

  it('screenRadius scales with zoom', () => {
    assert.equal(screenRadius(50, 2), 100);
    assert.equal(screenRadius(50, 0.5), 25);
  });

  it('lodLevel returns correct thresholds', () => {
    assert.equal(lodLevel(5, false, false), 'dot');
    assert.equal(lodLevel(20, false, false), 'circle');
    assert.equal(lodLevel(60, false, false), 'circle-meta');
    assert.equal(lodLevel(100, false, false), 'expanded');
    assert.equal(lodLevel(300, false, false), 'full');
  });

  it('lodLevel respects pinned collapsed', () => {
    assert.equal(lodLevel(300, true, false), 'dot');
  });

  it('lodLevel respects pinned expanded', () => {
    assert.equal(lodLevel(5, false, true), 'expanded');
  });

  it('computeExpansion respects budget', () => {
    const posMap = createPositionMap();
    const clusters = new Map();

    // Create 3 clusters of 2000 members each spread wide enough to expand
    for (let c = 0; c < 3; c++) {
      const members = new Set();
      for (let i = 0; i < 2000; i++) {
        const id = `c${c}_n${i}`;
        members.add(id);
        ensurePosition(posMap, id, c * 1000 + Math.random() * 500, Math.random() * 500);
      }
      clusters.set(`cluster:${c}`, {
        id: `cluster:${c}`,
        members,
        sourceHyperEdge: `he${c}`,
      });
    }

    // At high zoom, all clusters want to expand, but budget=5000 limits
    const { expanded, collapsed } = computeExpansion(clusters, posMap, 10, createContext(), 5000);
    assert.ok(expanded.size + collapsed.size === 3);
    // Not all 3 can expand (3*2000=6000 > 5000)
    assert.ok(collapsed.size >= 1, 'at least one cluster should be collapsed due to budget');
  });
});

// ─────────────────────────────────────────────────
// Meta-edges
// ─────────────────────────────────────────────────

describe('render/meta-edges', () => {
  it('clusterCentroid computes average position', () => {
    const posMap = createPositionMap();
    ensurePosition(posMap, 'a', 0, 0);
    ensurePosition(posMap, 'b', 100, 0);
    ensurePosition(posMap, 'c', 0, 100);

    const cluster = { id: 'c1', members: new Set(['a', 'b', 'c']), sourceHyperEdge: 'he1' };
    const centroid = clusterCentroid(cluster, posMap);
    assert.ok(Math.abs(centroid.x - 100/3) < 0.01);
    assert.ok(Math.abs(centroid.y - 100/3) < 0.01);
  });

  it('computeMetaEdges aggregates cross-cluster edges', () => {
    const edges = new Map([
      ['e1', makeEdge('e1', 'a', 'x', 'calls', 2)],
      ['e2', makeEdge('e2', 'b', 'x', 'calls', 3)],
      ['e3', makeEdge('e3', 'a', 'b', 'shared', 1)], // same cluster, no meta-edge
    ]);
    const nodeToCluster = new Map([
      ['a', 'cluster:A'], ['b', 'cluster:A'], ['x', 'cluster:X'],
    ]);

    const metaEdges = computeMetaEdges(edges, nodeToCluster);
    assert.equal(metaEdges.length, 1, 'should have 1 meta-edge (A<->X)');
    assert.equal(metaEdges[0].weight, 5); // 2+3
    assert.equal(metaEdges[0].count, 2);
    assert.ok(metaEdges[0].layers.includes('calls'));
  });

  it('no meta-edges for intra-cluster edges', () => {
    const edges = new Map([
      ['e1', makeEdge('e1', 'a', 'b', 'calls', 1)],
    ]);
    const nodeToCluster = new Map([['a', 'cluster:A'], ['b', 'cluster:A']]);
    const metaEdges = computeMetaEdges(edges, nodeToCluster);
    assert.equal(metaEdges.length, 0);
  });
});

// ─────────────────────────────────────────────────
// Hulls
// ─────────────────────────────────────────────────

describe('render/hulls', () => {
  it('computeHull returns convex hull points', () => {
    const posMap = createPositionMap();
    ensurePosition(posMap, 'a', 0, 0);
    ensurePosition(posMap, 'b', 100, 0);
    ensurePosition(posMap, 'c', 50, 100);
    ensurePosition(posMap, 'd', 50, 30); // interior point

    const cluster = { id: 'c1', members: new Set(['a', 'b', 'c', 'd']), sourceHyperEdge: 'he1' };
    const hull = computeHull(cluster, posMap);

    // Hull should have 3 points (d is interior)
    assert.equal(hull.length, 3, `hull should have 3 points, got ${hull.length}`);
  });

  it('expandHull inflates outward', () => {
    const hull = [[0, 0], [100, 0], [50, 100]];
    const expanded = expandHull(hull, 20);

    // Each point should be farther from centroid
    const cx = 50, cy = 100/3;
    for (let i = 0; i < hull.length; i++) {
      const origDist = Math.sqrt((hull[i][0] - cx) ** 2 + (hull[i][1] - cy) ** 2);
      const expDist = Math.sqrt((expanded[i][0] - cx) ** 2 + (expanded[i][1] - cy) ** 2);
      assert.ok(expDist > origDist, `point ${i}: expanded (${expDist.toFixed(1)}) should be farther than original (${origDist.toFixed(1)})`);
    }
  });

  it('handles fewer than 3 points gracefully', () => {
    const posMap = createPositionMap();
    ensurePosition(posMap, 'a', 0, 0);
    ensurePosition(posMap, 'b', 100, 0);

    const cluster = { id: 'c1', members: new Set(['a', 'b']), sourceHyperEdge: 'he1' };
    const hull = computeHull(cluster, posMap);
    assert.equal(hull.length, 2);
  });
});

// ─────────────────────────────────────────────────
// Render pump
// ─────────────────────────────────────────────────

describe('render/positions', () => {
  it('renderPositions increments counter', () => {
    resetRenderCount();
    assert.equal(getRenderCount(), 0);
    renderPositions(null);
    assert.equal(getRenderCount(), 1);
    renderPositions(null);
    assert.equal(getRenderCount(), 2);
  });

  it('counter resets', () => {
    renderPositions(null);
    resetRenderCount();
    assert.equal(getRenderCount(), 0);
  });
});

// ─────────────────────────────────────────────────
// SVG layer order
// ─────────────────────────────────────────────────

describe('render/svg', () => {
  it('LAYER_ORDER has 6 layers in correct order', () => {
    assert.equal(LAYER_ORDER.length, 6);
    assert.equal(LAYER_ORDER[0], 'gHulls');
    assert.equal(LAYER_ORDER[3], 'gNodes');
    assert.equal(LAYER_ORDER[5], 'gClusterLabels');
  });
});

// ─────────────────────────────────────────────────
// Fractal render plan
// ─────────────────────────────────────────────────

describe('render/fractal', () => {
  function buildTwoClusterGraph() {
    const nodes = new Map([
      ['a', { id: 'a', kind: 'function', label: 'a', importance: 1 }],
      ['b', { id: 'b', kind: 'function', label: 'b', importance: 1 }],
      ['c', { id: 'c', kind: 'function', label: 'c', importance: 1 }],
      ['x', { id: 'x', kind: 'function', label: 'x', importance: 1 }],
      ['y', { id: 'y', kind: 'function', label: 'y', importance: 1 }],
    ]);
    const edges = new Map([
      ['a->b', makeEdge('a->b', 'a', 'b', 'calls', 1)],
      ['b->c', makeEdge('b->c', 'b', 'c', 'calls', 1)],
      ['x->y', makeEdge('x->y', 'x', 'y', 'calls', 1)],
      ['a->x', makeEdge('a->x', 'a', 'x', 'shared', 1)], // cross-cluster
    ]);
    const clusters = new Map([
      ['cluster:alpha', { id: 'cluster:alpha', members: new Set(['a', 'b', 'c']), sourceHyperEdge: 'he1' }],
      ['cluster:beta', { id: 'cluster:beta', members: new Set(['x', 'y']), sourceHyperEdge: 'he2' }],
    ]);
    const posMap = createPositionMap();
    // Cluster alpha spread wide (will have large world radius)
    ensurePosition(posMap, 'a', -200, 0);
    ensurePosition(posMap, 'b', -100, 0);
    ensurePosition(posMap, 'c', -150, 80);
    // Cluster beta compact
    ensurePosition(posMap, 'x', 150, 0);
    ensurePosition(posMap, 'y', 170, 10);
    // Cluster-as-node positions
    ensurePosition(posMap, 'cluster:alpha', -150, 25);
    ensurePosition(posMap, 'cluster:beta', 160, 5);

    return { nodes, edges, clusters, posMap };
  }

  it('at low zoom, all clusters collapsed — plan has 2 cluster nodes', () => {
    const { nodes, edges, clusters, posMap } = buildTwoClusterGraph();
    const plan = computeRenderPlan({
      nodes, edges, clusters, posMap,
      context: createContext(),
      zoom: 0.1,  // very zoomed out — small screen radius
    });

    const clusterNodes = plan.nodes.filter(n => n.isCluster);
    assert.equal(clusterNodes.length, 2, `expected 2 collapsed clusters, got ${clusterNodes.length}`);
    assert.ok(clusterNodes.some(n => n.id === 'cluster:alpha'));
    assert.ok(clusterNodes.some(n => n.id === 'cluster:beta'));
    // No hulls at low zoom
    assert.equal(plan.hulls.length, 0);
  });

  it('at high zoom, clusters expand — plan has member nodes + hulls', () => {
    const { nodes, edges, clusters, posMap } = buildTwoClusterGraph();
    const plan = computeRenderPlan({
      nodes, edges, clusters, posMap,
      context: createContext(),
      zoom: 5,  // high zoom — large screen radius
    });

    // Should have member nodes, not cluster nodes (at least for the wide cluster)
    const memberNodes = plan.nodes.filter(n => !n.isCluster);
    assert.ok(memberNodes.length >= 3, `expected member nodes, got ${memberNodes.length}`);
    // Should have at least one hull
    assert.ok(plan.hulls.length >= 1, `expected hulls, got ${plan.hulls.length}`);
  });

  it('pinned-collapsed cluster stays as dot even at high zoom', () => {
    const { nodes, edges, clusters, posMap } = buildTwoClusterGraph();
    const ctx = createContext();
    ctx.pinnedClusters.add('cluster:alpha');

    const plan = computeRenderPlan({
      nodes, edges, clusters, posMap,
      context: ctx,
      zoom: 10,  // very high zoom
    });

    // Alpha should still be a single cluster node
    const alpha = plan.nodes.find(n => n.id === 'cluster:alpha');
    assert.ok(alpha, 'cluster:alpha should be in plan');
    assert.equal(alpha.isCluster, true);
    assert.equal(alpha.lod, 'dot');
  });

  it('budget limits expansion', () => {
    const nodes = new Map();
    const edges = new Map();
    const posMap = createPositionMap();

    // Create a cluster with 100 members
    const members = new Set();
    for (let i = 0; i < 100; i++) {
      const id = `n${i}`;
      nodes.set(id, { id, kind: 'function', label: id, importance: 1 });
      members.add(id);
      ensurePosition(posMap, id, Math.random() * 500, Math.random() * 500);
    }

    const clusters = new Map([
      ['cluster:big', { id: 'cluster:big', members, sourceHyperEdge: 'he1' }],
    ]);
    ensurePosition(posMap, 'cluster:big', 250, 250);

    // Budget of 10 — cluster can't expand
    const plan = computeRenderPlan({
      nodes, edges, clusters, posMap,
      context: createContext(),
      zoom: 10,
      budget: 10,
    });

    // Should have the cluster as a single node, not 100 member nodes
    assert.ok(plan.totalPrimitives <= 10, `budget exceeded: ${plan.totalPrimitives}`);
  });

  it('planStats counts per depth', () => {
    const { nodes, edges, clusters, posMap } = buildTwoClusterGraph();
    const plan = computeRenderPlan({
      nodes, edges, clusters, posMap,
      context: createContext(),
      zoom: 5,
    });

    const stats = planStats(plan);
    assert.ok(stats.size >= 1, 'should have at least one depth level');
    // Depth 0 should have entries
    const d0 = stats.get(0);
    assert.ok(d0, 'depth 0 should exist');
    assert.ok(d0.nodes >= 0);
  });

  it('meta-edges appear between collapsed clusters', () => {
    const { nodes, edges, clusters, posMap } = buildTwoClusterGraph();
    const plan = computeRenderPlan({
      nodes, edges, clusters, posMap,
      context: createContext(),
      zoom: 0.1,  // both collapsed
    });

    const metaEdges = plan.edges.filter(e => e.isMeta);
    assert.ok(metaEdges.length >= 1, `expected meta-edges between clusters, got ${metaEdges.length}`);
  });
});

// ─────────────────────────────────────────────────
// Semantic zoom
// ─────────────────────────────────────────────────

describe('navigation/semantic-zoom', () => {
  it('computeLOD returns entries for all clusters', () => {
    const posMap = createPositionMap();
    ensurePosition(posMap, 'a', 0, 0);
    ensurePosition(posMap, 'b', 100, 0);
    const clusters = new Map([
      ['cluster:X', { id: 'cluster:X', members: new Set(['a', 'b']), sourceHyperEdge: 'he1' }],
    ]);

    const lod = computeLOD(1.0, clusters, posMap, createContext());
    assert.equal(lod.size, 1);
    assert.ok(lod.has('cluster:X'));
  });

  it('higher zoom produces higher screen radius', () => {
    const posMap = createPositionMap();
    ensurePosition(posMap, 'a', 0, 0);
    ensurePosition(posMap, 'b', 100, 0);
    const clusters = new Map([
      ['cluster:X', { id: 'cluster:X', members: new Set(['a', 'b']), sourceHyperEdge: 'he1' }],
    ]);

    const lod1 = computeLOD(0.5, clusters, posMap, createContext());
    const lod2 = computeLOD(5.0, clusters, posMap, createContext());
    assert.ok(lod2.get('cluster:X').screenRadius > lod1.get('cluster:X').screenRadius);
  });

  it('lodDiff detects expand/collapse transitions', () => {
    const prev = new Map([
      ['c1', { clusterId: 'c1', lod: 'circle', screenRadius: 30, worldRadius: 60 }],
      ['c2', { clusterId: 'c2', lod: 'expanded', screenRadius: 100, worldRadius: 200 }],
    ]);
    const next = new Map([
      ['c1', { clusterId: 'c1', lod: 'expanded', screenRadius: 100, worldRadius: 60 }],
      ['c2', { clusterId: 'c2', lod: 'dot', screenRadius: 5, worldRadius: 200 }],
    ]);

    const diff = lodDiff(prev, next);
    assert.deepEqual(diff.expanded, ['c1']);
    assert.deepEqual(diff.collapsed, ['c2']);
  });
});

// ─────────────────────────────────────────────────
// Expand / collapse
// ─────────────────────────────────────────────────

describe('navigation/expand-collapse', () => {
  it('collapseCluster adds to pinnedClusters', () => {
    const ctx = createContext();
    const next = collapseCluster('cluster:X', ctx);
    assert.ok(next.pinnedClusters.has('cluster:X'));
    assert.ok(!ctx.pinnedClusters.has('cluster:X'), 'original unchanged');
  });

  it('expandCluster removes from pinnedClusters', () => {
    const ctx = collapseCluster('cluster:X', createContext());
    const next = expandCluster('cluster:X', ctx);
    assert.ok(!next.pinnedClusters.has('cluster:X'));
  });

  it('toggleCollapse toggles', () => {
    const ctx = createContext();
    const pinned = toggleCollapse('cluster:X', ctx);
    assert.ok(isPinnedCollapsed('cluster:X', pinned));
    const unpinned = toggleCollapse('cluster:X', pinned);
    assert.ok(!isPinnedCollapsed('cluster:X', unpinned));
  });
});
