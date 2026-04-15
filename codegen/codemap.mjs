#!/usr/bin/env node
/**
 * Phase 10c: Codemap producer.
 *
 * Reads `runtime/depgraph.md` (the human/AI-authored cluster map) and emits
 * NODE/EDGE history rows: one cluster node per `## Section`, one function
 * node per `- \`name\`` entry, one EDGE layer=memberOf per membership.
 *
 * The actual parser already lives at `src/data/codemap.js` (used by the
 * browser). This is the CLI / library wrapper that produces history rows.
 *
 * @module codegen/codemap
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCodemap } from '../src/data/codemap.js';
import { writeRowLine, HEADER } from '../src/data/csv.js';

/**
 * Convert a codemap markdown string into history rows (no `t` assigned).
 *
 * @param {string} markdown
 * @param {Object} [opts]
 * @param {string} [opts.author='codemap']
 * @returns {Array}
 */
export function codemapToRows(markdown, opts = {}) {
  const author = opts.author || 'codemap';
  const entries = parseCodemap(markdown);
  const rows = [];
  const seenClusters = new Set();
  const seenFunctions = new Set();

  for (const e of entries) {
    const clusterId = `cluster:${e.cluster}`;
    if (!seenClusters.has(clusterId)) {
      seenClusters.add(clusterId);
      rows.push({
        type: 'NODE',
        op: 'add',
        id: clusterId,
        kind: 'cluster',
        label: e.cluster,
        weight: 5,
        payload: { author },
      });
    }
    if (!seenFunctions.has(e.id)) {
      seenFunctions.add(e.id);
      rows.push({
        type: 'NODE',
        op: 'add',
        id: e.id,
        kind: 'function',
        label: e.id,
        weight: e.importance,
        payload: { line: e.line, author },
      });
    }
    rows.push({
      type: 'EDGE',
      op: 'add',
      id: `${e.id}->memberOf->${clusterId}`,
      source: e.id,
      target: clusterId,
      layer: 'memberOf',
      weight: 5,
      payload: { author },
    });
  }
  return rows;
}

/**
 * Read a codemap markdown file from disk and return rows.
 * @param {string} filePath
 */
export function rowsForCodemap(filePath) {
  const md = readFileSync(filePath, 'utf-8');
  return codemapToRows(md, { author: 'codemap' });
}

// ─── CLI ───────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = resolve(args[0] || 'runtime/depgraph.md');
  const rows = rowsForCodemap(file);
  console.log(HEADER);
  let t = 0;
  for (const r of rows) console.log(writeRowLine({ ...r, t: t++ }));
}
