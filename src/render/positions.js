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
 * When `state.smoothMotion` is true (e.g. during time travel or reset),
 * displayed positions ease toward posMap values rather than snapping.
 *
 * @param {RenderState} state
 */
export function renderPositions(state) {
  _renderCount++;

  if (!state || !state.posMap || !state.nodeElements) return;

  const { posMap, nodeElements, labelElements, edgeElements } = state;
  const display = state.displayPositions || null;
  const smooth = !!state.smoothMotion && display != null;
  const LERP = 0.18;

  for (const [id, el] of nodeElements) {
    const ps = posMap.positions.get(id);
    if (!ps) continue;

    let rx = ps.x;
    let ry = ps.y;
    if (display) {
      let dp = display.get(id);
      if (!dp) { dp = { x: ps.x, y: ps.y }; display.set(id, dp); }
      if (smooth) {
        dp.x += (ps.x - dp.x) * LERP;
        dp.y += (ps.y - dp.y) * LERP;
      } else {
        dp.x = ps.x;
        dp.y = ps.y;
      }
      rx = dp.x;
      ry = dp.y;
    }

    el.setAttribute('cx', rx);
    el.setAttribute('cy', ry);

    if (labelElements) {
      const label = labelElements.get(id);
      if (label) {
        label.setAttribute('x', rx);
        label.setAttribute('y', ry - 12);
      }
    }
  }

  // Keep edge endpoints + their proximity gradients attached to display positions.
  if (edgeElements && display) {
    const gradientElements = state.gradientElements;
    for (const [id, line] of edgeElements) {
      const sid = line.getAttribute('data-source');
      const tid = line.getAttribute('data-target');
      if (!sid || !tid) continue;
      const ds = display.get(sid);
      const dt = display.get(tid);
      let sx, sy, tx, ty;
      if (ds) { sx = ds.x; sy = ds.y; line.setAttribute('x1', ds.x); line.setAttribute('y1', ds.y); }
      if (dt) { tx = dt.x; ty = dt.y; line.setAttribute('x2', dt.x); line.setAttribute('y2', dt.y); }
      if (gradientElements && sx != null && tx != null) {
        const g = gradientElements.get(id);
        if (g) updateGradientStopsInline(g, sx, sy, tx, ty);
      }
    }
  }
}

// Kept inline rather than importing from main.js to avoid a module cycle.
function updateGradientStopsInline(grad, sx, sy, tx, ty) {
  grad.grad.setAttribute('x1', sx);
  grad.grad.setAttribute('y1', sy);
  grad.grad.setAttribute('x2', tx);
  grad.grad.setAttribute('y2', ty);
  const dx = tx - sx, dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let midOp;
  if (dist <= 60) midOp = 1.0;
  else if (dist >= 250) midOp = 0.08;
  else midOp = 1.0 - ((dist - 60) / 190) * 0.92;
  grad.stops[1].setAttribute('stop-opacity', String(midOp));
  grad.stops[2].setAttribute('stop-opacity', String(midOp * 0.7));
  grad.stops[3].setAttribute('stop-opacity', String(midOp));
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
