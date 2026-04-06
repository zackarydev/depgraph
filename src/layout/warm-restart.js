/**
 * Sticky-preserving re-settle on rebuild.
 *
 * After a rebuild (new rows added), run a short gradient descent
 * from current positions. Sticky nodes barely move. New nodes
 * get seeded and settle near their neighbors.
 *
 * @module layout/warm-restart
 */

import { ensurePosition } from './positions.js';
import { descentStep } from './gradient.js';

const MAX_WARM_STEPS = 60;
const CONVERGE_EPSILON = 0.5;

/**
 * Re-settle an existing layout after new nodes/edges arrive.
 *
 * - Existing nodes keep their positions.
 * - New nodes (in `nodes` but not in `posMap`) are seeded at neighbor centroid.
 * - A short descent pass re-settles everything.
 *
 * @param {import('./positions.js').PositionMap} posMap - mutated in place
 * @param {Map<string, import('../core/types.js').Node>} nodes
 * @param {Map<string, import('../core/types.js').Edge>} edges
 * @param {import('../core/types.js').WeightVector} [W]
 * @returns {{ steps: number, converged: boolean, newNodes: string[] }}
 */
export function warmRestart(posMap, nodes, edges, W) {
  const newNodes = [];

  // Seed new nodes at neighbor centroid
  for (const [nodeId] of nodes) {
    if (posMap.positions.has(nodeId)) continue;

    let cx = 0, cy = 0, count = 0;
    for (const [, edge] of edges) {
      let neighbor = null;
      if (edge.source === nodeId) neighbor = edge.target;
      else if (edge.target === nodeId) neighbor = edge.source;
      else continue;

      const ps = posMap.positions.get(neighbor);
      if (ps) { cx += ps.x; cy += ps.y; count++; }
    }

    if (count > 0) {
      cx /= count;
      cy /= count;
    } else {
      cx = (Math.random() - 0.5) * 400;
      cy = (Math.random() - 0.5) * 400;
    }

    cx += (Math.random() - 0.5) * 20;
    cy += (Math.random() - 0.5) * 20;

    ensurePosition(posMap, nodeId, cx, cy);
    newNodes.push(nodeId);
  }

  // Short descent to re-settle
  let steps = 0;
  let converged = false;
  for (steps = 0; steps < MAX_WARM_STEPS; steps++) {
    const { gradMag } = descentStep(posMap, edges, W, { eta: 0.3 });
    if (gradMag < CONVERGE_EPSILON) {
      converged = true;
      break;
    }
  }

  return { steps, converged, newNodes };
}
