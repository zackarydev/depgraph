/**
 * Initial layout + streaming placement.
 *
 * - initialPlace: seed all nodes, run gradient descent until converged.
 * - streamPlace: seed a new node at neighbor centroid, brief local descent.
 *
 * @module layout/placement
 */

import { createPositionMap, ensurePosition } from './positions.js';
import { descentStep } from './gradient.js';

const MAX_INITIAL_STEPS = 300;
const MAX_STREAM_STEPS = 30;
const CONVERGE_EPSILON = 0.5;

/**
 * Place all nodes from scratch via gradient descent.
 *
 * @param {Map<string, import('../core/types.js').Node>} nodes
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WeightVector} [W]
 * @param {Object} [options]
 * @param {number} [options.maxSteps]
 * @param {number} [options.epsilon]
 * @returns {{ posMap: import('./positions.js').PositionMap, steps: number, converged: boolean }}
 */
export function initialPlace(nodes, edges, W, options) {
  const maxSteps = (options && options.maxSteps) || MAX_INITIAL_STEPS;
  const epsilon = (options && options.epsilon) || CONVERGE_EPSILON;

  const posMap = createPositionMap();

  // Seed positions in a circle
  const nodeIds = [...nodes.keys()];
  const n = nodeIds.length;
  if (n === 0) return { posMap, steps: 0, converged: true };

  const radius = Math.max(50 * Math.sqrt(n), 200);
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    ensurePosition(posMap, nodeIds[i], x, y);
  }

  // Run descent
  let steps = 0;
  let converged = false;
  for (steps = 0; steps < maxSteps; steps++) {
    const { gradMag } = descentStep(posMap, edges, W);
    if (gradMag < epsilon) {
      converged = true;
      break;
    }
  }

  return { posMap, steps, converged };
}

/**
 * Place a new node into an existing layout.
 * Seeds at centroid of its connected neighbors, then runs brief descent.
 *
 * @param {string} nodeId
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('./positions.js').PositionMap} posMap - existing positions (mutated)
 * @param {import('../core/types.js').WeightVector} [W]
 * @returns {{ steps: number, converged: boolean }}
 */
export function streamPlace(nodeId, edges, posMap, W) {
  // Find neighbors
  let cx = 0, cy = 0, count = 0;
  for (const [, edge] of edges) {
    let neighbor = null;
    if (edge.source === nodeId) neighbor = edge.target;
    else if (edge.target === nodeId) neighbor = edge.source;
    else continue;

    const ps = posMap.positions.get(neighbor);
    if (ps) {
      cx += ps.x;
      cy += ps.y;
      count++;
    }
  }

  if (count > 0) {
    cx /= count;
    cy /= count;
  } else {
    // No neighbors — place at a random-ish offset from origin
    cx = (Math.random() - 0.5) * 200;
    cy = (Math.random() - 0.5) * 200;
  }

  // Add slight jitter to avoid exact overlap
  cx += (Math.random() - 0.5) * 20;
  cy += (Math.random() - 0.5) * 20;

  ensurePosition(posMap, nodeId, cx, cy);

  // Brief local descent
  let steps = 0;
  let converged = false;
  for (steps = 0; steps < MAX_STREAM_STEPS; steps++) {
    const { gradMag } = descentStep(posMap, edges, W, { eta: 0.3 });
    if (gradMag < CONVERGE_EPSILON) {
      converged = true;
      break;
    }
  }

  return { steps, converged };
}
