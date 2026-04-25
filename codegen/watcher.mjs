#!/usr/bin/env node
/**
 * Phase 10f: Live repo watcher.
 *
 * On startup it scans the repository once and remembers every file's
 * `{nodes, edges}` fingerprint. Then it subscribes to fs.watch on the root,
 * and whenever a file is added / changed / removed it:
 *
 *   1. Re-runs the appropriate handler on the file.
 *   2. Diffs the new {nodes, edges} against the snapshot for that file.
 *   3. Emits NODE/EDGE add/update/remove rows to a sink (default: append
 *      to runtime/history.csv).
 *   4. Updates its in-memory snapshot.
 *
 * Because every row goes through `validateRow`, a malformed handler cannot
 * corrupt history.csv. Because the SSE tail of history.csv is the same path
 * the browser already uses, **edits propagate to the live UI with no extra
 * wiring** — Phase 7 already knows how to consume that stream.
 *
 * The diff function is exported separately so the test suite can exercise
 * it without touching the filesystem.
 *
 * CLI:
 *   node codegen/watcher.mjs                 # watch ./ , append to runtime/history.csv
 *   node codegen/watcher.mjs --root src/ --out runtime/history.csv
 *
 * @module codegen/watcher
 */

import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { scanFile, scanRepo, handlerFor } from './repo-scanner.mjs';
import { appendHistory } from './graphgen.mjs';
import { validateRow, writeRowLine, HEADER } from '../src/data/csv.js';

/**
 * Compute the diff between two handler outputs (old vs new) for the same file.
 * Returns NODE/EDGE add/update/remove rows (no `t` assigned).
 *
 * Accepts either the legacy `{nodes, edges}` shape or the newer interleaved
 * `{rows}` shape (see repo-scanner.scanFile).
 *
 * - id present in `next` but not `prev`         → add
 * - id present in `prev` but not `next`         → remove
 * - id present in both with different payload   → update
 *
 * @param {{nodes?:Array,edges?:Array,rows?:Array}|null} prev
 * @param {{nodes?:Array,edges?:Array,rows?:Array}} next
 * @returns {Array}
 */
export function diffHandlerOutput(prev, next) {
  const rows = [];

  // Handlers return one of two shapes: legacy {nodes, edges} or interleaved
  // {rows} (each row tagged type:'NODE'|'EDGE'). Fold either into id→object
  // maps, keeping only add/update rows — a remove in the source would just
  // mean "not present", which the diff will rediscover.
  const indexOut = (out) => {
    const nodes = new Map();
    const edges = new Map();
    if (!out) return { nodes, edges };
    if (Array.isArray(out.rows)) {
      for (const r of out.rows) {
        if (r.op === 'remove') continue;
        if (r.type === 'NODE') nodes.set(r.id, r);
        else if (r.type === 'EDGE') edges.set(r.id, r);
      }
    }
    if (Array.isArray(out.nodes)) for (const n of out.nodes) nodes.set(n.id, n);
    if (Array.isArray(out.edges)) for (const e of out.edges) edges.set(e.id, e);
    return { nodes, edges };
  };

  const { nodes: prevNodes, edges: prevEdges } = indexOut(prev);
  const { nodes: nextNodes, edges: nextEdges } = indexOut(next);

  // Node adds + updates
  for (const [id, n] of nextNodes) {
    const old = prevNodes.get(id);
    if (!old) {
      rows.push({
        type: 'NODE', op: 'add', id,
        kind: n.kind, label: n.label,
        weight: n.importance ?? 3,
        payload: n.payload || null,
      });
    } else if (!shallowEqual(old.payload, n.payload) || old.label !== n.label) {
      rows.push({
        type: 'NODE', op: 'update', id,
        kind: n.kind, label: n.label,
        weight: n.importance ?? 3,
        payload: n.payload || null,
      });
    }
  }
  // Node removes
  for (const [id] of prevNodes) {
    if (!nextNodes.has(id)) {
      rows.push({ type: 'NODE', op: 'remove', id });
    }
  }
  // Edge adds + updates
  for (const [id, e] of nextEdges) {
    const old = prevEdges.get(id);
    if (!old) {
      rows.push({
        type: 'EDGE', op: 'add', id,
        source: e.source, target: e.target, layer: e.layer,
        weight: e.weight ?? 1, label: e.label || null,
        payload: e.payload || null,
      });
    } else if ((old.weight ?? 1) !== (e.weight ?? 1)) {
      rows.push({
        type: 'EDGE', op: 'update', id,
        source: e.source, target: e.target, layer: e.layer,
        weight: e.weight ?? 1,
      });
    }
  }
  // Edge removes
  for (const [id] of prevEdges) {
    if (!nextEdges.has(id)) {
      rows.push({ type: 'EDGE', op: 'remove', id });
    }
  }

  // Tag every diff row with author=watcher so the UI can filter live edits.
  for (const r of rows) {
    r.payload = { ...(r.payload || {}), author: 'watcher' };
  }
  return rows;
}

function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k] && JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

/**
 * Create a stateful watcher. Returns an object with `feed(filePath)` and
 * `snapshot` so a host (server, test) can drive it from any source.
 *
 * @param {string} rootPath
 * @param {Object} [opts]
 * @param {function(Array):void} [opts.onRows] - sink for diff rows
 * @returns {{feed:Function, remove:Function, snapshot:Map}}
 */
export function createWatcher(rootPath, opts = {}) {
  const absRoot = resolve(rootPath);
  /** @type {Map<string, {nodes:Array,edges:Array}>} */
  const snapshot = new Map();
  const onRows = opts.onRows || (() => {});

  function feed(absPath) {
    if (!existsSync(absPath)) return remove(absPath);
    const rel = relative(absRoot, absPath);
    let next;
    try { next = scanFile(absPath, absRoot); } catch { return; }
    const prev = snapshot.get(rel) || null;
    const rows = diffHandlerOutput(prev, next);
    snapshot.set(rel, next);
    if (rows.length) onRows(rows);
  }

  function remove(absPath) {
    const rel = relative(absRoot, absPath);
    const prev = snapshot.get(rel);
    if (!prev) return;
    const rows = diffHandlerOutput(prev, { nodes: [], edges: [] });
    snapshot.delete(rel);
    if (rows.length) onRows(rows);
  }

  // Seed the snapshot from a single full scan so the first diff is meaningful.
  function seed() {
    const stack = [absRoot];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(abs);
        else if (entry.isFile()) {
          try {
            const rel = relative(absRoot, abs);
            snapshot.set(rel, scanFile(abs, absRoot));
          } catch {}
        }
      }
    }
  }

  return { feed, remove, snapshot, seed };
}

// ─── CLI ───────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const outIdx = args.indexOf('--out');
  const root = resolve(rootIdx !== -1 ? args[rootIdx + 1] : '.');
  const outPath = resolve(outIdx !== -1 ? args[outIdx + 1] : 'runtime/history.csv');

  console.error(`[watcher] seeding scan of ${root}`);
  const seedRows = scanRepo(root);
  appendHistory(outPath, seedRows);
  console.error(`[watcher] seeded ${seedRows.length} rows → ${outPath}`);

  const watcher = createWatcher(root, {
    onRows(rows) {
      // Stamp + validate.
      const stamped = [];
      let t = Date.now();
      for (const r of rows) {
        const row = { ...r, t: t++ };
        if (!validateRow(row)) stamped.push(row);
      }
      appendHistory(outPath, stamped);
      for (const r of stamped) console.error(`[watcher] ${r.type} ${r.op} ${r.id}`);
    },
  });

  watcher.seed();

  console.error(`[watcher] watching ${root}`);
  watch(root, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.includes('node_modules') || filename.includes('.git/')) return;
    if (filename.endsWith('history.csv')) return;
    const abs = join(root, filename);
    try {
      const s = statSync(abs);
      if (s.isFile()) watcher.feed(abs);
    } catch {
      watcher.remove(abs);
    }
  });
}
