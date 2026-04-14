/**
 * SVG initialization: create SVG element, 6 layer groups, D3 zoom.
 *
 * Layer stack (bottom -> top per SPEC §9):
 *   1. gHulls        — cluster polygons + textPath boundary labels
 *   2. gMetaLinks    — inter-cluster bezier gradients
 *   3. gLinks        — individual edges
 *   4. gNodes        — circles + affinity rings
 *   5. gLabels       — node text
 *   6. gClusterLabels — floating cluster names
 *
 * Browser-only module. No-op / returns null in Node.
 *
 * @module render/svg
 */

/** Layer group names in order (bottom to top). */
export const LAYER_ORDER = [
  'gHulls',
  'gMetaLinks',
  'gLinks',
  'gNodes',
  'gLabels',
  'gClusterLabels',
];

/**
 * @typedef {Object} SVGContext
 * @property {Element} svg - the <svg> element
 * @property {Element} root - the <g> that gets zoom-transformed
 * @property {Object} layers - { gHulls, gMetaLinks, gLinks, gNodes, gLabels, gClusterLabels }
 * @property {{ x: number, y: number, k: number }} transform - current zoom transform
 */

/**
 * Initialize the SVG viewport inside a container element.
 * Creates the layer stack and wires D3 zoom (if d3 is available).
 *
 * @param {Element} container - DOM element to append SVG to
 * @param {Object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @returns {SVGContext|null} null if not in a browser
 */
export function initSVG(container, options) {
  if (typeof document === 'undefined') return null;

  const width = (options && options.width) || container.clientWidth || 960;
  const height = (options && options.height) || container.clientHeight || 700;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  container.appendChild(svg);

  // <defs> holds per-edge linearGradients reused by fullRender.
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  svg.appendChild(defs);

  // Root group that gets zoom-transformed
  const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  root.setAttribute('class', 'depgraph-root');
  svg.appendChild(root);

  // Create layer groups
  const layers = {};
  for (const name of LAYER_ORDER) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', name);
    root.appendChild(g);
    layers[name] = g;
  }

  const ctx = {
    svg,
    defs,
    root,
    layers,
    transform: { x: 0, y: 0, k: 1 },
  };

  return ctx;
}
