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
