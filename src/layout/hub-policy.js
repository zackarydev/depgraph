/**
 * Layout hub policy — kinds whose nodes are excluded from gradient descent
 * and from BFS expansion when scoping a local relax burst.
 *
 * Hubs are singleton-shared marker nodes (sentinels, interned vocabulary
 * values, agent identities). They have very high degree because every event
 * row attaches to them, so BFS through them floods the graph and gradient
 * pull from them yanks subjects toward a small set of fixed points.
 *
 * Skipping them in layout keeps the audit trail intact (rows still record,
 * edges still queryable) while preventing the visual distortion. A future
 * rewrite rule may revisit hub propagation under different semantics.
 *
 * @module layout/hub-policy
 */

const HUB_KINDS = new Set(['sentinel', 'value', 'agent']);

export function isLayoutHub(node) {
  return !!(node && HUB_KINDS.has(node.kind));
}
