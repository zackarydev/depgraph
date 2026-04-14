/**
 * Cinematic mode: zoom-tour to each new visible node as live rows arrive.
 *
 * When enabled, each new NODE add from a live source triggers a smooth
 * camera pan + zoom to the new node with a highlight ring that fades.
 *
 * @module stream/cinematic
 */

/**
 * @typedef {Object} CinematicState
 * @property {boolean} active
 * @property {string[]} queue - node IDs waiting to be toured
 * @property {string|null} current - node being highlighted
 * @property {number} tourDuration - ms per node tour
 * @property {number} startTime - when current tour started
 */

/**
 * Start cinematic mode. Wires to the bus and intercepts new node adds.
 *
 * @param {Object} bus - event bus
 * @param {Object} options
 * @param {Object} options.posMap - position map
 * @param {Object} options.svgCtx - SVG context with transform
 * @param {Function} options.fullRender - trigger a full re-render
 * @param {number} [options.tourDuration=1500] - ms spent on each node
 * @returns {CinematicState}
 */
export function startCinematic(bus, { posMap, svgCtx, fullRender, tourDuration = 1500 }) {
  const state = {
    active: true,
    queue: [],
    current: null,
    tourDuration,
    startTime: 0,
    _unsub: null,
    _highlightEl: null,
  };

  // Listen for new rows
  state._unsub = bus.on('row-appended', ({ row }) => {
    if (!state.active) return;
    if (row.type === 'NODE' && row.op === 'add') {
      state.queue.push(row.id);
      if (!state.current) {
        advanceTour(state, posMap, svgCtx, fullRender);
      }
    }
  });

  return state;
}

/**
 * Advance to the next node in the tour queue.
 */
function advanceTour(state, posMap, svgCtx, fullRender) {
  // Clean up previous highlight
  removeHighlight(state, svgCtx);

  if (state.queue.length === 0 || !state.active) {
    state.current = null;
    return;
  }

  const nodeId = state.queue.shift();
  state.current = nodeId;
  state.startTime = performance.now();

  const pos = posMap.positions.get(nodeId);
  if (!pos || !svgCtx) {
    // Node not placed yet, skip
    advanceTour(state, posMap, svgCtx, fullRender);
    return;
  }

  // Pan camera to the node
  panToNode(pos, svgCtx);

  // Add highlight ring
  addHighlight(state, nodeId, pos, svgCtx);

  // Schedule removal and advance
  setTimeout(() => {
    if (state.current === nodeId) {
      advanceTour(state, posMap, svgCtx, fullRender);
    }
  }, state.tourDuration);
}

/**
 * Pan the SVG viewport to center on a world-space position.
 */
function panToNode(pos, svgCtx) {
  if (!svgCtx || !svgCtx.svg) return;

  const svg = svgCtx.svg;
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;

  // Compute transform to center on node at current scale
  const k = svgCtx.transform ? svgCtx.transform.k : 1;
  const targetK = Math.max(k, 2); // zoom in at least 2x for visibility
  const tx = cx - pos.x * targetK;
  const ty = cy - pos.y * targetK;

  // Apply via d3 if available, otherwise direct transform
  if (typeof d3 !== 'undefined' && d3.select && d3.zoomIdentity) {
    const transform = d3.zoomIdentity.translate(tx, ty).scale(targetK);
    d3.select(svg).transition().duration(800).call(
      d3.zoom().transform,
      transform
    );
  } else if (svgCtx.root) {
    svgCtx.root.setAttribute('transform', `translate(${tx},${ty}) scale(${targetK})`);
    svgCtx.transform = { x: tx, y: ty, k: targetK };
  }
}

/**
 * Add a pulsing highlight ring around a node.
 */
function addHighlight(state, nodeId, pos, svgCtx) {
  if (!svgCtx || !svgCtx.layers) return;

  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', pos.x);
  circle.setAttribute('cy', pos.y);
  circle.setAttribute('r', '20');
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke', '#ff0');
  circle.setAttribute('stroke-width', '3');
  circle.setAttribute('stroke-opacity', '1');
  circle.setAttribute('class', 'cinematic-highlight');

  // Pulse animation via CSS if available
  circle.style.animation = 'cinematic-pulse 0.8s ease-in-out infinite';

  svgCtx.layers.gNodes.appendChild(circle);
  state._highlightEl = circle;
}

/**
 * Remove the current highlight ring.
 */
function removeHighlight(state, svgCtx) {
  if (state._highlightEl) {
    try { state._highlightEl.remove(); } catch {}
    state._highlightEl = null;
  }
}

/**
 * Stop cinematic mode.
 * @param {CinematicState} state
 */
export function stopCinematic(state) {
  if (!state) return;
  state.active = false;
  state.queue = [];
  state.current = null;
  if (state._unsub) {
    state._unsub();
    state._unsub = null;
  }
}

/**
 * Check if cinematic mode is active.
 * @param {CinematicState} state
 * @returns {boolean}
 */
export function isCinematicActive(state) {
  return state ? state.active : false;
}
