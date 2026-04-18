#!/usr/bin/env node

/**
 * One-shot migrator: rewrites a legacy runtime/history.csv (11 columns
 * including a JSON `payload`) as a new-format CSV (10 columns) with every
 * payload field expanded into first-class value-node + property-edge rows.
 *
 * This file is not part of the codegen pipeline. It's a throwaway — commit
 * it, run it once, then delete it in a follow-up commit.
 *
 * Usage:
 *   node migrate-history.mjs runtime/history.csv runtime/history.migrated.csv
 *
 * Design notes:
 *   - Agent singletons (`user`, `codemap`, `ast`, `repo-scanner`, `system`,
 *     `watcher`) are seeded at the top of the output so `authored-by` edges
 *     have real targets.
 *   - Position pairs (x, y) become `moment:pos:<hlc>` nodes with prop:x /
 *     prop:y / prop:subject edges. HLC uses `migrate` as producer id and
 *     counts up from a synthetic wallMs equal to the original row's t.
 *   - Every other payload field becomes `value:<key>:<canonical>` + a
 *     prop:<key> edge.
 *   - Each emitted row is stamped with a fresh monotonic t starting from
 *     (max legacy t) + 1. The originals keep their ts so earlier behavior
 *     is preserved; the expansions bunch up immediately after.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseLine, writeLine, rowToFields, HEADER } from './src/data/csv.js';
import { expandPayload, agentSeedRows } from './src/data/payload-expand.js';

function canonicalNumber(n) { return Number(n).toFixed(3); }

function createMigrateHLC(baseMs) {
  let last = baseMs;
  let counter = 0;
  return {
    next() {
      counter++;
      return `${last}:migrate:${counter}`;
    },
    bump(ms) {
      if (ms > last) { last = ms; counter = 0; }
    },
  };
}

/**
 * Parse a legacy row (11 columns) — keeps the payload JSON so we can expand.
 */
function parseLegacyFields(fields) {
  let payload = null;
  if (fields[10]) {
    try { payload = JSON.parse(fields[10]); } catch { payload = null; }
  }
  const weight = fields[8] !== '' ? Number(fields[8]) : undefined;
  return {
    t: Number(fields[0]),
    type: fields[1],
    op: fields[2],
    id: fields[3],
    kind: fields[4] || undefined,
    source: fields[5] || undefined,
    target: fields[6] || undefined,
    layer: fields[7] || undefined,
    weight: Number.isNaN(weight) ? undefined : weight,
    label: fields[9] || undefined,
    payload,
  };
}

function stripPayload(row) {
  const { payload, ...rest } = row;
  return rest;
}

function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('usage: node migrate-history.mjs <input.csv> <output.csv>');
    process.exit(2);
  }

  const raw = readFileSync(inPath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const start = lines[0] && lines[0].startsWith('t,type,') ? 1 : 0;

  const legacyRows = [];
  for (let i = start; i < lines.length; i++) {
    const fields = parseLine(lines[i]);
    if (fields.length < 4) continue;
    legacyRows.push(parseLegacyFields(fields));
  }

  const maxLegacyT = legacyRows.reduce((m, r) => (r.t > m ? r.t : m), 0);
  let nextT = maxLegacyT + 1;
  const hlc = createMigrateHLC(maxLegacyT + 1);

  const out = [HEADER];

  // Seed agent singletons first so authored-by targets exist.
  for (const seed of agentSeedRows()) {
    out.push(writeLine(rowToFields({ ...seed, t: nextT++ })));
  }

  // Preserve the originals (minus the payload column), then emit their
  // expansions immediately after each original.
  for (const legacy of legacyRows) {
    hlc.bump(legacy.t);
    out.push(writeLine(rowToFields(stripPayload(legacy))));
    if (!legacy.payload) continue;
    const expanded = expandPayload({
      subjectId: legacy.id,
      payload: legacy.payload,
      hlc,
    });
    for (const r of expanded) {
      out.push(writeLine(rowToFields({ ...r, t: nextT++ })));
    }
  }

  writeFileSync(outPath, out.join('\n') + '\n', 'utf-8');
  console.log(`migrated ${legacyRows.length} rows → ${out.length - 1} rows in ${outPath}`);
}

main();
