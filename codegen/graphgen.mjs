#!/usr/bin/env node
/**
 * Phase 10d: Combined producer.
 *
 * Orchestrates the AST producer + codemap producer + repo scanner, dedupes
 * across producers, assigns timestamps, validates each row against the frozen
 * schema, and appends the result to `runtime/history.csv`.
 *
 * CLI:
 *   node codegen/graphgen.mjs                      # uses inspect.json + scans the repo
 *   node codegen/graphgen.mjs --no-scan            # skip whole-repo scan, just AST + codemap
 *   node codegen/graphgen.mjs --out runtime/x.csv  # write to a different file
 *   node codegen/graphgen.mjs --stdout             # print rather than write
 *
 * @module codegen/graphgen
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { rowsForFile as rowsForJsFile } from './ast.mjs';
import { rowsForCodemap } from './codemap.mjs';
import { scanRepo } from './repo-scanner.mjs';
import { writeRowLine, HEADER, validateRow } from '../src/data/csv.js';

/**
 * Read inspect.json (or fall back to defaults).
 */
function loadInspect(path = 'inspect.json') {
  try {
    const txt = readFileSync(path, 'utf-8');
    return JSON.parse(txt);
  } catch {
    return {
      name: 'depgraph',
      src: 'src/main.js',
      codemap: 'runtime/depgraph.md',
      root: '.',
    };
  }
}

/**
 * Generate rows from all configured producers.
 *
 * @param {Object} cfg
 * @param {string} [cfg.src]      - JS entrypoint to AST-parse
 * @param {string} [cfg.codemap]  - codemap markdown file
 * @param {string} [cfg.root]     - repo root for full scan
 * @param {boolean} [cfg.scan]    - whether to scan the whole repo
 * @returns {Array} validated, timestamped HistoryRow[]
 */
export function generate(cfg) {
  const collected = [];
  const seenIds = new Set();

  function add(rows, source) {
    for (const r of rows) {
      const tagged = { ...r, payload: { ...(r.payload || {}), producer: source } };
      // Dedup by composite key (type+id) — last writer wins for updates.
      const key = `${tagged.type}::${tagged.id}`;
      if (tagged.op === 'add' && seenIds.has(key)) continue;
      seenIds.add(key);
      collected.push(tagged);
    }
  }

  if (cfg.src && existsSync(cfg.src)) {
    add(rowsForJsFile(cfg.src, { relPath: relative(cfg.root || '.', cfg.src) }), 'ast');
  }
  if (cfg.codemap && existsSync(cfg.codemap)) {
    add(rowsForCodemap(cfg.codemap), 'codemap');
  }
  if (cfg.scan && cfg.root) {
    add(scanRepo(cfg.root), 'repo-scanner');
  }

  // Assign monotonic timestamps + validate.
  const rows = [];
  let t = 0;
  for (const r of collected) {
    const stamped = { ...r, t: t++ };
    const err = validateRow(stamped);
    if (err) {
      console.error(`[graphgen] dropping invalid row (${err}):`, stamped.id);
      continue;
    }
    rows.push(stamped);
  }
  return rows;
}

/**
 * Write rows to a history.csv file (overwrite mode).
 * @param {string} outPath
 * @param {Array} rows
 */
export function writeHistory(outPath, rows) {
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lines = [HEADER];
  for (const r of rows) lines.push(writeRowLine(r));
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Append rows to an existing history.csv (creating it with header if needed).
 * @param {string} outPath
 * @param {Array} rows
 */
export function appendHistory(outPath, rows) {
  if (!rows.length) return;
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!existsSync(outPath)) {
    writeFileSync(outPath, HEADER + '\n', 'utf-8');
  }
  const lines = rows.map(writeRowLine).join('\n') + '\n';
  appendFileSync(outPath, lines, 'utf-8');
}

// ─── CLI ───────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const noScan = args.includes('--no-scan');
  const stdout = args.includes('--stdout');
  const outPath = resolve(outIdx !== -1 ? args[outIdx + 1] : 'runtime/history.csv');

  const cfg = loadInspect();
  cfg.root = resolve(cfg.root || '.');
  cfg.src = cfg.src ? resolve(cfg.src) : null;
  cfg.codemap = cfg.codemap ? resolve(cfg.codemap) : null;
  cfg.scan = !noScan;

  const rows = generate(cfg);

  if (stdout) {
    console.log(HEADER);
    for (const r of rows) console.log(writeRowLine(r));
  } else {
    writeHistory(outPath, rows);
    console.log(`[graphgen] wrote ${rows.length} rows → ${outPath}`);
  }
}
