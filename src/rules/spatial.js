/**
 * `spatial` system property.
 *
 * A node is spatial when history contains BOTH an x-slot and a y-slot edge
 * outgoing from it (see interact/drag.js `positionRows`). The predicate is
 * derived purely from the edge stream — slot nodes themselves are not
 * spatial because no x/y edges originate from them.
 *
 * The listener's `nodes` map holds references into state.nodes, so consumers
 * (renderer, computeSpatialEdges, future quadtree index) observe mutations
 * to the underlying node objects without a copy step.
 *
 * @module rules/spatial
 */

export const SPATIAL_PROPERTY = 'spatial';

/**
 * Build a spatial property spec. The returned spec owns closure-local
 * per-node counters tracking how many x-layer and y-layer edges are
 * outgoing from each node.
 *
 * @returns {import('../core/properties.js').PropertySpec}
 */
export function createSpatialProperty() {
  /** @type {Map<string, number>} */
  const xCount = new Map();
  /** @type {Map<string, number>} */
  const yCount = new Map();

  function refresh(ctx, id) {
    const xs = xCount.get(id) || 0;
    const ys = yCount.get(id) || 0;
    const node = ctx.state.nodes.get(id);
    if (xs > 0 && ys > 0 && node) {
      if (!ctx.nodes.has(id)) ctx.nodes.set(id, node);
    } else {
      ctx.nodes.delete(id);
    }
  }

  function bump(map, id, delta) {
    const next = (map.get(id) || 0) + delta;
    if (next <= 0) map.delete(id);
    else map.set(id, next);
  }

  return {
    name: SPATIAL_PROPERTY,

    onEdgeAdd(ctx) {
      const { row } = ctx;
      if (row.layer !== 'x' && row.layer !== 'y') return;
      const src = row.source;
      if (!src) return;
      bump(row.layer === 'x' ? xCount : yCount, src, +1);
      refresh(ctx, src);
    },

    onEdgeRemove(ctx) {
      const { row } = ctx;
      if (row.layer !== 'x' && row.layer !== 'y') return;
      const src = row.source;
      if (!src) return;
      bump(row.layer === 'x' ? xCount : yCount, src, -1);
      refresh(ctx, src);
    },

    onNodeAdd(ctx) {
      // Node may have been added after its x/y edges (replay order is not
      // guaranteed for streamed rows). If counters already show both, admit.
      refresh(ctx, ctx.row.id);
    },

    onNodeRemove(ctx) {
      const id = ctx.row.id;
      xCount.delete(id);
      yCount.delete(id);
      ctx.nodes.delete(id);
    },

    onReset() {
      xCount.clear();
      yCount.clear();
    },
  };
}
