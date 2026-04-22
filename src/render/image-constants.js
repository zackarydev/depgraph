/**
 * Shared constants for the image-as-hypergraph rendering path.
 *
 * PIXEL_PITCH is both the grid spacing in world units (layout.main) and
 * the rect side-length the renderer paints (render.v3). They must match
 * so the image tiles seamlessly at low zoom.
 *
 * @module render/image-constants
 */

export const PIXEL_PITCH = 16;

/**
 * Turn a pixel node's `label` ("r,g,b") into a CSS `rgb(...)` string.
 * Falls back to mid-grey for a missing or malformed label.
 *
 * @param {string|null|undefined} label
 * @returns {string}
 */
export function parsePixelColor(label) {
  if (!label) return 'rgb(128,128,128)';
  if (!/^\s*\d+\s*,\s*\d+\s*,\s*\d+\s*$/.test(label)) return 'rgb(128,128,128)';
  return `rgb(${label})`;
}
