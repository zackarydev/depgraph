/**
 * Edge opacity — single source of truth.
 *
 * Computes the visual opacity for an edge based on the context's
 * per-layer opacity weight and the edge's own weight.
 *
 * @module edges/opacity
 */

const MIN_OPACITY = 0.05;
const MAX_OPACITY = 1.0;

/**
 * Compute the visual opacity for an edge.
 *
 * opacity = clamp(layerOpacity * edgeWeight, MIN_OPACITY, MAX_OPACITY)
 *
 * @param {import('../core/types.js').Edge} edge
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {number} 0..1
 */
export function edgeOpacity(edge, context) {
  const layerOpacity = (context.weights.opacity && context.weights.opacity[edge.layer] != null)
    ? context.weights.opacity[edge.layer]
    : 1.0;

  if (layerOpacity <= 0) return 0;

  const edgeWeight = Math.min(edge.weight || 1, 5) / 5; // normalize to 0..1
  const raw = layerOpacity * (0.3 + 0.7 * edgeWeight); // base 0.3 + weight contribution

  return Math.max(MIN_OPACITY, Math.min(MAX_OPACITY, raw));
}
