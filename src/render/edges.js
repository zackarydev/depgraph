/**
 * Edge rendering: lines with layer colors, optional arrowheads.
 *
 * Browser-only D3 data join on visible edges.
 *
 * @module render/edges
 */

import { getLayer } from '../edges/layers.js';
import { edgeOpacity } from '../edges/opacity.js';

/**
 * Render/update edge lines in the gLinks layer.
 *
 * @param {Element} gLinks - SVG group for edges
 * @param {Array<import('../core/types.js').Edge>} edgeData
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {Map<string, Element>} edgeId -> line element
 */
export function renderEdges(gLinks, edgeData, posMap, context) {
  if (!gLinks || typeof document === 'undefined') return new Map();

  const elements = new Map();

  while (gLinks.firstChild) gLinks.removeChild(gLinks.firstChild);

  for (const edge of edgeData) {
    const ps = posMap.positions.get(edge.source);
    const pt = posMap.positions.get(edge.target);
    if (!ps || !pt) continue;

    const layerDef = getLayer(edge.layer);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', ps.x);
    line.setAttribute('y1', ps.y);
    line.setAttribute('x2', pt.x);
    line.setAttribute('y2', pt.y);
    line.setAttribute('stroke', layerDef ? layerDef.color : '#888');
    line.setAttribute('stroke-width', Math.max(0.5, Math.min(3, edge.weight || 1)));
    line.setAttribute('stroke-opacity', edgeOpacity(edge, context));
    line.setAttribute('data-id', edge.id);
    line.setAttribute('class', `edge edge-${edge.layer}`);

    if (layerDef && layerDef.dash) {
      line.setAttribute('stroke-dasharray', layerDef.dash);
    }

    gLinks.appendChild(line);
    elements.set(edge.id, line);
  }

  return elements;
}
