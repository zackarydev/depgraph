/**
 * Label rendering: node labels + floating cluster labels.
 *
 * Browser-only D3 data join. Labels are placed above their node
 * with basic collision avoidance.
 *
 * @module render/labels
 */

/**
 * Render/update node labels in the gLabels layer.
 *
 * @param {Element} gLabels - SVG group for labels
 * @param {Array<{ id: string, label: string }>} labelData
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {Map<string, Element>} nodeId -> text element
 */
export function renderLabels(gLabels, labelData, posMap) {
  if (!gLabels || typeof document === 'undefined') return new Map();

  const elements = new Map();

  while (gLabels.firstChild) gLabels.removeChild(gLabels.firstChild);

  for (const item of labelData) {
    const ps = posMap.positions.get(item.id);
    if (!ps) continue;

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', ps.x);
    text.setAttribute('y', ps.y - 12);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'label');
    text.setAttribute('data-id', item.id);
    text.setAttribute('font-size', '10');
    text.setAttribute('fill', '#333');
    text.textContent = item.label;

    gLabels.appendChild(text);
    elements.set(item.id, text);
  }

  return elements;
}

/**
 * Render cluster labels in the gClusterLabels layer.
 *
 * @param {Element} gClusterLabels - SVG group
 * @param {Array<{ id: string, label: string, x: number, y: number }>} clusterLabelData
 * @returns {Map<string, Element>}
 */
export function renderClusterLabels(gClusterLabels, clusterLabelData) {
  if (!gClusterLabels || typeof document === 'undefined') return new Map();

  const elements = new Map();

  while (gClusterLabels.firstChild) gClusterLabels.removeChild(gClusterLabels.firstChild);

  for (const item of clusterLabelData) {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', item.x);
    text.setAttribute('y', item.y);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'cluster-label');
    text.setAttribute('data-cluster', item.id);
    text.setAttribute('font-size', '13');
    text.setAttribute('font-weight', 'bold');
    text.setAttribute('fill', '#555');
    text.textContent = item.label;

    gClusterLabels.appendChild(text);
    elements.set(item.id, text);
  }

  return elements;
}
