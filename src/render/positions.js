/**
 * Render pump: called ONCE per frame by the scheduler.
 *
 * Transforms all visible DOM elements to their current positions
 * from the PositionMap. This is the only function that touches
 * element transforms each frame.
 *
 * @module render/positions
 */

/**
 * @typedef {Object} RenderState
 * @property {import('../layout/positions.js').PositionMap} posMap
 * @property {Set<string>} visibleNodes - node IDs currently in DOM
 * @property {import('./svg.js').SVGContext} svgCtx
 * @property {Map<string, Element>} nodeElements - nodeId -> DOM circle
 * @property {Map<string, Element>} labelElements - nodeId -> DOM text
 */

/** Counter for instrumentation/testing. */
let _renderCount = 0;

/**
 * Get the render call count (for testing).
 * @returns {number}
 */
export function getRenderCount() {
  return _renderCount;
}

/**
 * Reset the render count (for testing).
 */
export function resetRenderCount() {
  _renderCount = 0;
}

/**
 * Update all visible elements' positions. Called once per frame.
 *
 * @param {RenderState} state
 */
export function renderPositions(state) {
  _renderCount++;

  if (!state || !state.posMap || !state.nodeElements) return;

  const { posMap, nodeElements, labelElements } = state;

  for (const [id, el] of nodeElements) {
    const ps = posMap.positions.get(id);
    if (!ps) continue;

    el.setAttribute('cx', ps.x);
    el.setAttribute('cy', ps.y);

    // Update corresponding label if it exists
    if (labelElements) {
      const label = labelElements.get(id);
      if (label) {
        label.setAttribute('x', ps.x);
        label.setAttribute('y', ps.y - 12);
      }
    }
  }
}

/**
 * Create a render function bound to a state object.
 * Suitable for registering with the scheduler as the render callback.
 *
 * @param {RenderState} state
 * @returns {function}
 */
export function createRenderFn(state) {
  return () => renderPositions(state);
}
