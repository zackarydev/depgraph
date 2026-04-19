/**
 * Expand a legacy-style payload object into partial history rows so each
 * field lands in the hypergraph as a first-class node/edge instead of a
 * JSON blob on the primary row.
 *
 * Id scheme (see docs/experiments/payload-expansion.md):
 *   - Slot keys (runtime scalars: x, y, distance, stretch):
 *     NODE id = `<hlc>:<key>:<owner>`, kind='slot', label=value.
 *     EDGE id = `<hlc>:<key>:<owner>`, layer=<key>, source=owner, target=slot.
 *     Every write is a distinct slot — two owners that both write x=100 do
 *     NOT alias; slot nodes are memory cells, not interned values.
 *   - Interned keys (categorical vocabulary: kind, action, path, …):
 *     NODE id = `<key>:<canonical>`, kind='value'. Shared across subjects.
 *     EDGE id = `<hlc>:<key>:<owner>`, layer=<key>.
 *   - Reference keys (payload value IS a node id: cluster, target, author,
 *     producer, file): no derived node; edge points straight at the referent.
 *     EDGE id = `<hlc>:<key>:<owner>`, layer=<key>.
 *
 * The HLC's `<wallMs>:<producerId>:<counter>` format already guarantees
 * global uniqueness, so no `value:`, `prop:`, `moment:pos:` sentinels are
 * needed on derived ids.
 *
 * Rows returned are partial (no `t`) — the caller runs them through the
 * normal append path so each gets a monotonic timestamp.
 *
 * @module data/payload-expand
 */

import { EDGE_LAYERS } from '../edges/layers.js';

export const AGENT_IDS = ['user', 'codemap', 'ast', 'repo-scanner', 'system', 'migrate'];

const SLOT_KEYS = new Set(['x', 'y', 'distance', 'stretch']);
const REFERENCE_KEYS = new Set(['cluster', 'target', 'author', 'producer', 'file']);

const LAYER_COLORS = {
  x:        '#bdc3c7',
  y:        '#bdc3c7',
  distance: '#bdc3c7',
  stretch:  '#ff922b',
  author:   '#4a90d9',
  producer: '#50c878',
  cluster:  '#7b68ee',
  target:   '#9b59b6',
  file:     '#f39c12',
  kind:     '#95a5a6',
  action:   '#95a5a6',
  path:     '#95a5a6',
};
for (const [id, color] of Object.entries(LAYER_COLORS)) {
  if (!EDGE_LAYERS.has(id)) {
    EDGE_LAYERS.set(id, { id, color, dash: '1,2', directed: true, visible: false });
  }
}

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

/**
 * Rows that seed the singleton agent nodes referenced by author/producer
 * edges. Idempotent — callers can safely emit these on every boot.
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
 * @param {{next: function(): string}} opts.hlc - HLC clock for minting ids
 * @returns {Array<Partial<import('../core/types.js').HistoryRow>>}
 */
export function expandPayload({ subjectId, payload, hlc }) {
  if (!payload || !subjectId) return [];
  const rows = [];
  // One HLC per payload: all edges derived from this write share the prefix,
  // so they read as facets of the same moment in the graph.
  const hlcId = hlc ? hlc.next() : `${Date.now()}:local:0`;

  for (const [key, raw] of Object.entries(payload)) {
    if (raw == null) continue;
    const edgeId = `${hlcId}:${key}:${subjectId}`;

    if (SLOT_KEYS.has(key)) {
      rows.push({
        type: 'NODE',
        op: 'add',
        id: edgeId,
        kind: 'slot',
        weight: 0.1,
        label: String(raw),
      });
      rows.push({
        type: 'EDGE',
        op: 'add',
        id: edgeId,
        source: subjectId,
        target: edgeId,
        layer: key,
        weight: 1,
      });
      continue;
    }

    if (REFERENCE_KEYS.has(key)) {
      rows.push({
        type: 'EDGE',
        op: 'add',
        id: edgeId,
        source: subjectId,
        target: String(raw),
        layer: key,
        weight: 1,
      });
      continue;
    }

    const canonical = canonicalValue(raw);
    if (canonical == null) continue;
    const internedId = `${key}:${canonical}`;
    rows.push({
      type: 'NODE',
      op: 'add',
      id: internedId,
      kind: 'value',
      weight: 0.1,
      label: String(raw),
    });
    rows.push({
      type: 'EDGE',
      op: 'add',
      id: edgeId,
      source: subjectId,
      target: internedId,
      layer: key,
      weight: 1,
    });
  }

  return rows;
}

/**
 * Parse a slot node id into {key, owner}. Returns null if the id doesn't
 * match the `<wallMs>:<producerId>:<counter>:<key>:<owner>` shape. Owner
 * may itself contain colons; it's everything after the 4th colon.
 */
export function parseSlotId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  if (parts.length < 5) return null;
  return { key: parts[3], owner: parts.slice(4).join(':') };
}
