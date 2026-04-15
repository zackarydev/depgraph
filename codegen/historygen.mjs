#!/usr/bin/env node
/**
 * Phase 10e: Historygen — replay-pack producer.
 *
 * Takes a derived state (nodes + edges, e.g. from a snapshot) and emits a
 * fresh, replayable history that, when applied to an empty state, produces
 * an identical graph. This is the inverse of state.applyRow over a stream.
 *
 * It is also useful as a "compactor": given an existing history.csv, replay
 * to its cursor, then re-emit a minimal history (one add per surviving
 * primitive), discarding intermediate updates and removed entities.
 *
 * CLI:
 *   node codegen/historygen.mjs runtime/history.csv > runtime/history.compact.csv
 *
 * @module codegen/historygen
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCSV, writeRowLine, HEADER, validateRow } from '../src/data/csv.js';
import { replayRows } from '../src/core/state.js';

/**
 * Convert a derived State into a replayable list of NODE/EDGE add rows.
 *
 * @param {{nodes:Map,edges:Map}} state
 * @returns {Array}
 */
export function stateToHistoryRows(state) {
  const rows = [];
  let t = 0;
  for (const [, n] of state.nodes) {
    rows.push({
      t: t++,
      type: 'NODE',
      op: 'add',
      id: n.id,
      kind: n.kind || 'unknown',
      label: n.label || n.id,
      weight: n.importance ?? 1,
      payload: n.payload || null,
    });
  }
  for (const [, e] of state.edges) {
    rows.push({
      t: t++,
      type: 'EDGE',
      op: 'add',
      id: e.id,
      source: e.source,
      target: e.target,
      layer: e.layer,
      weight: e.weight ?? 1,
      label: e.label || null,
      payload: e.payload || null,
    });
  }
  return rows;
}

/**
 * Compact a history CSV: replay it, then emit the minimal equivalent.
 *
 * @param {string} csvText
 * @returns {Array}
 */
export function compactHistory(csvText) {
  const rows = parseCSV(csvText);
  const state = replayRows(rows);
  const compacted = stateToHistoryRows(state);
  // Validate every row before returning.
  return compacted.filter(r => {
    const err = validateRow(r);
    if (err) console.error(`[historygen] dropping ${r.id}: ${err}`);
    return !err;
  });
}

// ─── CLI ───────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node codegen/historygen.mjs <history.csv> [--out path]');
    process.exit(1);
  }
  const inPath = resolve(args[0]);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 ? resolve(args[outIdx + 1]) : null;
  const csv = readFileSync(inPath, 'utf-8');
  const rows = compactHistory(csv);
  const text = [HEADER, ...rows.map(writeRowLine)].join('\n') + '\n';
  if (outPath) {
    writeFileSync(outPath, text, 'utf-8');
    console.error(`[historygen] wrote ${rows.length} rows → ${outPath}`);
  } else {
    process.stdout.write(text);
  }
}
