/**
 * Expand a legacy-style payload object into partial history rows so each
 * field lands in the hypergraph as a first-class node/edge instead of a
 * JSON blob on the primary row.
 *
 * Conventions:
 *   - Scalar field K → `value:K:<canonical>` NODE + `prop:<source-id>:K`
 *     EDGE in layer `prop:K`.
 *   - `author` / `producer` → `authored-by` / `produced-by` edge to a
 *     singleton agent node (`user`, `codemap`, `ast`, `repo-scanner`).
 *   - `x` + `y` pair → a `moment:pos:<hlc>` NODE that owns `prop:x` and
 *     `prop:y` value-node edges plus a `prop:subject` edge pointing at
 *     the original subject. Gives positions their own HLC moment.
 *
 * Rows returned are partial (no `t`) — the caller runs them through the
 * normal append path so each gets a monotonic timestamp.
 *
 * @module data/payload-expand
 */

import { EDGE_LAYERS } from '../edges/layers.js';

export const AGENT_IDS = ['user', 'codemap', 'ast', 'repo-scanner', 'system', 'migrate'];

const SYNTHETIC_LAYERS = [
  ['authored-by',   '#4a90d9'],
  ['produced-by',   '#50c878'],
  ['prop:subject',  '#7b68ee'],
  ['prop:x',        '#bdc3c7'],
  ['prop:y',        '#bdc3c7'],
  ['prop:stretch',  '#ff922b'],
];

for (const [id, color] of SYNTHETIC_LAYERS) {
  if (!EDGE_LAYERS.has(id)) {
    EDGE_LAYERS.set(id, { id, color, dash: '1,2', directed: true, visible: false });
  }
}

/**
 * Quantize a number to 3 decimal places so near-duplicates collapse onto
 * a single `value:*` node. Keeps cardinality bounded without losing
 * meaningful precision on positions.
 */
function canonicalNumber(n) {
  return Number(n).toFixed(3);
}

function canonicalValue(v) {
  if (v == null) return null;
  if (typeof v === 'number') return canonicalNumber(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function valueNodeRow(key, canonical, label) {
  return {
    type: 'NODE',
    op: 'add',
    id: `value:${key}:${canonical}`,
    kind: 'value',
    weight: 0.1,
    label: String(label),
  };
}

function propEdgeRow(sourceId, key, canonical) {
  return {
    type: 'EDGE',
    op: 'add',
    id: `prop:${sourceId}:${key}`,
    source: sourceId,
    target: `value:${key}:${canonical}`,
    layer: `prop:${key}`,
    weight: 1,
  };
}

function agentEdgeRow(sourceId, layer, agentId) {
  return {
    type: 'EDGE',
    op: 'add',
    id: `${layer}:${sourceId}:${agentId}`,
    source: sourceId,
    target: agentId,
    layer,
    weight: 1,
  };
}

/**
 * Rows that seed the singleton agent nodes referenced by authored-by /
 * produced-by edges. Idempotent — callers can safely emit these on every
 * boot; applyRow overwrites identically.
 */
export function agentSeedRows() {
  return AGENT_IDS.map((id) => ({
    type: 'NODE',
    op: 'add',
    id,
    kind: 'agent',
    weight: 0.3,
    label: id,
  }));
}

/**
 * @param {Object} opts
 * @param {string} opts.subjectId - id of the node/edge the payload describes
 * @param {Object} opts.payload   - the legacy payload object
 * @param {{next: function(): string}} opts.hlc - HLC clock for minting position-moment ids
 * @returns {Array<Partial<import('../core/types.js').HistoryRow>>}
 */
export function expandPayload({ subjectId, payload, hlc }) {
  if (!payload || !subjectId) return [];
  const rows = [];

  const hasX = typeof payload.x === 'number';
  const hasY = typeof payload.y === 'number';
  const hasPosition = hasX && hasY;

  let propSubject = subjectId;

  if (hasPosition) {
    const hlcId = hlc ? hlc.next() : String(Date.now());
    const momentId = `moment:pos:${hlcId}`;
    rows.push({
      type: 'NODE',
      op: 'add',
      id: momentId,
      kind: 'moment',
      weight: 0.2,
      label: `pos@${hlcId}`,
    });
    rows.push({
      type: 'EDGE',
      op: 'add',
      id: `prop:${momentId}:subject`,
      source: momentId,
      target: subjectId,
      layer: 'prop:subject',
      weight: 1,
    });
    propSubject = momentId;
  }

  for (const [key, raw] of Object.entries(payload)) {
    if (raw == null) continue;
    if (key === 'author') {
      rows.push(agentEdgeRow(propSubject, 'authored-by', String(raw)));
      continue;
    }
    if (key === 'producer') {
      rows.push(agentEdgeRow(propSubject, 'produced-by', String(raw)));
      continue;
    }
    const canonical = canonicalValue(raw);
    if (canonical == null) continue;
    rows.push(valueNodeRow(key, canonical, raw));
    rows.push(propEdgeRow(propSubject, key, canonical));
  }

  return rows;
}
