/**
 * T-BFS: forward/backward/both, flash, hold.
 *
 * Trace propagates a visual BFS wave through the on-screen portion
 * of the hypergraph, following enabled edge layers.
 *
 * SPEC §10 + controls.md:
 * - Tap T: flash — instant full BFS with staggered animation
 * - Hold T: trace — BFS one hop at a time, speeds up over hold
 * - T+B: backward edges only
 * - T+F: forward edges only
 * - H during trace: hold visuals (persist after T release)
 * - H again or Escape: clear held trace
 *
 * Pure logic: computes wavefronts. Rendering reads the trace state.
 *
 * @module interact/trace
 */

/**
 * @typedef {'both'|'forward'|'backward'} TraceDirection
 */

/**
 * @typedef {Object} TraceState
 * @property {boolean} active - whether a trace is in progress
 * @property {string} sourceId - BFS origin node
 * @property {TraceDirection} direction
 * @property {Map<string, number>} visited - nodeId -> wavefront index
 * @property {Set<string>} visitedEdges - edge ids that were traversed
 * @property {string[][]} wavefronts - array of wavefront arrays (index = hop distance)
 * @property {number} currentWave - index of current wavefront being revealed
 * @property {number} elapsed - ms since last wave step
 * @property {number} waveInterval - ms between wavefronts (decreases over hold)
 * @property {boolean} held - whether H was pressed to hold visuals
 * @property {boolean} complete - whether BFS has finished
 */

/**
 * Build adjacency index for fast BFS.
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {Map<string, Array<{neighbor: string, edgeId: string, isForward: boolean}>>}
 */
export function buildAdjacency(edges, context) {
  const adj = new Map();

  for (const [eid, edge] of edges) {
    // Skip edges not in the active lens
    if (!context.lensEdgeLayers.has(edge.layer)) continue;

    if (!adj.has(edge.source)) adj.set(edge.source, []);
    if (!adj.has(edge.target)) adj.set(edge.target, []);

    // Forward: source -> target
    adj.get(edge.source).push({ neighbor: edge.target, edgeId: eid, isForward: true });

    // Backward: target -> source (only if undirected, or always for reverse traversal)
    if (!edge.directed) {
      adj.get(edge.target).push({ neighbor: edge.source, edgeId: eid, isForward: true });
    } else {
      adj.get(edge.target).push({ neighbor: edge.source, edgeId: eid, isForward: false });
    }
  }

  return adj;
}

/**
 * Compute full BFS wavefronts from a source node.
 *
 * @param {string} sourceId
 * @param {Map<string, Array<{neighbor: string, edgeId: string, isForward: boolean}>>} adj
 * @param {TraceDirection} direction
 * @param {Set<string>} [visibleNodes] - if provided, only trace through visible nodes
 * @returns {{ wavefronts: string[][], visited: Map<string, number>, visitedEdges: Set<string> }}
 */
export function computeBFS(sourceId, adj, direction, visibleNodes) {
  const visited = new Map();
  const visitedEdges = new Set();
  const wavefronts = [[sourceId]];
  visited.set(sourceId, 0);

  let frontier = [sourceId];
  let wave = 0;

  while (frontier.length > 0) {
    wave++;
    const nextFrontier = [];

    for (const nodeId of frontier) {
      const neighbors = adj.get(nodeId) || [];
      for (const { neighbor, edgeId, isForward } of neighbors) {
        // Direction filter
        if (direction === 'forward' && !isForward) continue;
        if (direction === 'backward' && isForward) continue;

        // Visibility filter
        if (visibleNodes && !visibleNodes.has(neighbor)) continue;

        if (!visited.has(neighbor)) {
          visited.set(neighbor, wave);
          visitedEdges.add(edgeId);
          nextFrontier.push(neighbor);
        }
      }
    }

    if (nextFrontier.length > 0) {
      wavefronts.push(nextFrontier);
    }
    frontier = nextFrontier;
  }

  return { wavefronts, visited, visitedEdges };
}

/**
 * Start a held trace (T held down). Reveals one wavefront at a time.
 *
 * @param {string} sourceId
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WorkingContext} context
 * @param {TraceDirection} [direction='both']
 * @param {Set<string>} [visibleNodes]
 * @returns {TraceState}
 */
export function startTrace(sourceId, edges, context, direction = 'both', visibleNodes) {
  const adj = buildAdjacency(edges, context);
  const { wavefronts, visited, visitedEdges } = computeBFS(sourceId, adj, direction, visibleNodes);

  return {
    active: true,
    sourceId,
    direction,
    visited,
    visitedEdges,
    wavefronts,
    currentWave: 0,
    elapsed: 0,
    waveInterval: 1000,
    held: false,
    complete: wavefronts.length <= 1,
  };
}

/**
 * Flash trace: compute full BFS instantly and mark all wavefronts revealed.
 *
 * @param {string} sourceId
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WorkingContext} context
 * @param {Set<string>} [visibleNodes]
 * @returns {TraceState}
 */
export function flashTrace(sourceId, edges, context, visibleNodes) {
  const adj = buildAdjacency(edges, context);
  const { wavefronts, visited, visitedEdges } = computeBFS(sourceId, adj, 'both', visibleNodes);

  return {
    active: true,
    sourceId,
    direction: 'both',
    visited,
    visitedEdges,
    wavefronts,
    currentWave: wavefronts.length - 1,
    elapsed: 0,
    waveInterval: 1000,
    held: false,
    complete: true,
  };
}

/**
 * Per-frame update: advance wavefront if enough time has elapsed.
 * Returns whether a new wavefront was revealed this frame.
 *
 * @param {TraceState} trace
 * @param {number} dt - ms since last frame
 * @returns {boolean} true if a new wavefront was revealed
 */
export function updateTrace(trace, dt) {
  if (!trace.active || trace.complete) return false;

  trace.elapsed += dt;

  // Speed ramps up: interval decreases linearly from 1000ms to ~330ms
  trace.waveInterval = Math.max(330, 1000 - trace.currentWave * 80);

  if (trace.elapsed >= trace.waveInterval) {
    trace.elapsed = 0;
    trace.currentWave++;

    if (trace.currentWave >= trace.wavefronts.length - 1) {
      trace.complete = true;
    }

    return true;
  }

  return false;
}

/**
 * Hold the trace visuals (H pressed during trace).
 * @param {TraceState} trace
 */
export function holdTrace(trace) {
  trace.held = true;
}

/**
 * Release/clear the trace.
 * @param {TraceState} trace
 */
export function releaseTrace(trace) {
  trace.active = false;
  trace.held = false;
}

/**
 * Change trace direction mid-trace (T+B or T+F).
 * Recomputes BFS from the current wavefront edge.
 *
 * @param {TraceState} trace
 * @param {TraceDirection} newDirection
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WorkingContext} context
 * @param {Set<string>} [visibleNodes]
 * @returns {TraceState}
 */
export function changeDirection(trace, newDirection, edges, context, visibleNodes) {
  // Resume from current wavefront nodes
  const currentNodes = trace.wavefronts[trace.currentWave] || [trace.sourceId];
  const adj = buildAdjacency(edges, context);

  // BFS forward from current wavefront in the new direction
  const newVisited = new Map(trace.visited);
  const newEdges = new Set(trace.visitedEdges);
  const newWavefronts = [...trace.wavefronts.slice(0, trace.currentWave + 1)];

  let frontier = currentNodes;
  let wave = trace.currentWave;

  while (frontier.length > 0) {
    wave++;
    const nextFrontier = [];

    for (const nodeId of frontier) {
      const neighbors = adj.get(nodeId) || [];
      for (const { neighbor, edgeId, isForward } of neighbors) {
        if (newDirection === 'forward' && !isForward) continue;
        if (newDirection === 'backward' && isForward) continue;
        if (visibleNodes && !visibleNodes.has(neighbor)) continue;

        if (!newVisited.has(neighbor)) {
          newVisited.set(neighbor, wave);
          newEdges.add(edgeId);
          nextFrontier.push(neighbor);
        }
      }
    }

    if (nextFrontier.length > 0) {
      newWavefronts.push(nextFrontier);
    }
    frontier = nextFrontier;
  }

  return {
    ...trace,
    direction: newDirection,
    visited: newVisited,
    visitedEdges: newEdges,
    wavefronts: newWavefronts,
    complete: false,
  };
}

/**
 * Get currently revealed nodes (up to currentWave).
 * @param {TraceState} trace
 * @returns {Set<string>}
 */
export function revealedNodes(trace) {
  const set = new Set();
  for (let i = 0; i <= trace.currentWave && i < trace.wavefronts.length; i++) {
    for (const id of trace.wavefronts[i]) set.add(id);
  }
  return set;
}

/**
 * Get currently revealed edges.
 * @param {TraceState} trace
 * @returns {Set<string>}
 */
export function revealedEdges(trace) {
  return trace.visitedEdges;
}
