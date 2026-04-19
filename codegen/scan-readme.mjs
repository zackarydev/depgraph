#!/usr/bin/env node
/**
 * Single-file scan: root + README.md + all of its mdast structure.
 *
 * Emits runtime/history.csv with exactly:
 *   dir:.  →  file:README.md  →  headings  →  paragraphs/code/lists  →  sentences
 *
 * No other files, no other noise — so you can eyeball whether the hypergraph
 * faithfully represents a known source.
 *
 * Usage:
 *   node codegen/scan-readme.mjs                    # default: README.md at repo root
 *   node codegen/scan-readme.mjs path/to/file.md    # any markdown file
 *   node codegen/scan-readme.mjs --out path.csv
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

import { scanFile } from './repo-scanner.mjs';
import { writeRowLine, HEADER, validateRow } from '../src/data/csv.js';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 ? resolve(args[outIdx + 1]) : resolve('runtime/history.csv');
const positional = args.filter(a => !a.startsWith('--'));
// Skip the --out value.
const filtered = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') { i++; continue; }
  if (args[i].startsWith('--')) continue;
  filtered.push(args[i]);
}
const targetRel = filtered[0] || 'README.md';
const rootPath = resolve('.');
const absTarget = resolve(rootPath, targetRel);

if (!existsSync(absTarget)) {
  console.error(`[scan-readme] file not found: ${absTarget}`);
  process.exit(1);
}

const rows = [];
let t = 0;
function push(row) {
  const stamped = { ...row, t: t++ };
  const err = validateRow(stamped);
  if (err) {
    console.error(`[scan-readme] dropping ${stamped.id}: ${err}`);
    return;
  }
  rows.push(stamped);
}

// Root directory node.
const rootId = 'dir:.';
push({
  type: 'NODE',
  op: 'add',
  id: rootId,
  kind: 'directory',
  label: basename(rootPath),
  payload: { path: '.', isRoot: true },
});

// dir → file edge.
const fileId = `file:${targetRel}`;
push({
  type: 'NODE',
  op: 'add',
  id: fileId,
  kind: 'markdown-file',
  label: basename(targetRel),
  payload: { path: targetRel },
});
push({
  type: 'EDGE',
  op: 'add',
  id: `${rootId}->contains->${fileId}`,
  source: rootId,
  target: fileId,
  layer: 'contains',
  weight: 2,
});

// Scan the single file; scanFile also emits its own file node and contains-edge
// for nested parents, but since our file is at root we handle that ourselves above.
const { nodes, edges } = scanFile(absTarget, rootPath);
const seen = new Set([rootId, fileId]);
for (const n of nodes) {
  if (seen.has(n.id)) continue;
  seen.add(n.id);
  push({ type: 'NODE', op: 'add', ...n });
}
for (const e of edges) {
  // Drop any auto-emitted parent-contains edges that would dup what we did.
  if (e.layer === 'contains' && e.target === fileId) continue;
  push({
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

const text = [HEADER, ...rows.map(writeRowLine)].join('\n') + '\n';
const dir = dirname(outPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(outPath, text, 'utf-8');
console.error(`[scan-readme] wrote ${rows.length} rows (${nodes.length + 1} nodes, ${edges.length + 1} edges) → ${outPath}`);
