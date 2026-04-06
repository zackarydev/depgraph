/**
 * Node rendering: circles + affinity rings.
 *
 * D3 data join on visible nodes. Browser-only.
 * Returns the nodeElements map for use by the render pump.
 *
 * @module render/nodes
 */

/**
 * Render/update node circles in the gNodes layer.
 * Uses D3 data join (enter/update/exit).
 *
 * @param {Element} gNodes - SVG group for nodes
 * @param {Array<{ id: string, kind: string, label: string, importance: number }>} nodeData
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @param {Object} [callbacks] - { onClick, onDrag, onForcePress }
 * @returns {Map<string, Element>} nodeId -> circle element
 */
export function renderNodes(gNodes, nodeData, posMap, callbacks) {
  if (!gNodes || typeof document === 'undefined') return new Map();

  const elements = new Map();

  // D3-style join would go here. For v1 we use raw DOM as D3 may not be loaded.
  // Clear and rebuild (Phase 9 will optimize to incremental join).

  // Remove old circles
  while (gNodes.firstChild) gNodes.removeChild(gNodes.firstChild);

  for (const node of nodeData) {
    const ps = posMap.positions.get(node.id);
    if (!ps) continue;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', ps.x);
    circle.setAttribute('cy', ps.y);
    circle.setAttribute('r', baseRadius(node));
    circle.setAttribute('class', `node node-${node.kind}`);
    circle.setAttribute('data-id', node.id);
    circle.setAttribute('fill', kindColor(node.kind));
    circle.setAttribute('stroke', '#333');
    circle.setAttribute('stroke-width', '1');

    if (callbacks && callbacks.onClick) {
      circle.addEventListener('click', (e) => callbacks.onClick(node.id, e));
    }

    gNodes.appendChild(circle);
    elements.set(node.id, circle);
  }

  return elements;
}

function baseRadius(node) {
  const imp = node.importance || 1;
  return Math.max(4, Math.min(20, 4 + imp * 2));
}

function kindColor(kind) {
  const colors = {
    'function': '#4a90d9',
    'global': '#e74c3c',
    'module': '#2ecc71',
    'cluster': '#9b59b6',
    'parameter': '#f39c12',
    'value': '#1abc9c',
    'user-action': '#e67e22',
  };
  return colors[kind] || '#95a5a6';
}
