#!/usr/bin/env node
/**
 * Phase 10f: Universal repo → hypergraph scanner.
 *
 * Walks an entire repository (respecting a small ignore list) and converts
 * every file into NODE/EDGE history rows via a pluggable handler registry.
 * The result is the user's vision: **everything in the repo is in the graph.**
 *
 *   - directories                 → NODE kind=directory, EDGE layer=contains
 *   - .js/.mjs/.cjs files          → js handler (functions, globals, calls, reads, writes)
 *   - .json files                  → json handler (package.json scripts, deps, keys)
 *   - .md files                    → markdown handler (headings + next-edges)
 *   - images                       → image handler (kind=image, src=path)
 *   - everything else              → text handler (one node per file)
 *
 * The result is deterministic: re-running the scanner twice on an unchanged
 * repo produces the same row set (same ids, same payloads). That property is
 * what makes the live watcher's diff trivial — see `codegen/watcher.mjs`.
 *
 * CLI:
 *   node codegen/repo-scanner.mjs [root]                        # print rows as CSV
 *   node codegen/repo-scanner.mjs [root] --out runtime/x.csv
 *
 * @module codegen/repo-scanner
 */

import { readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname, sep, basename, extname } from 'node:path';

import * as jsHandler from './handlers/js.mjs';
import * as jsonHandler from './handlers/json.mjs';
import * as imageHandler from './handlers/image.mjs';
import * as markdownHandler from './handlers/markdown.mjs';
import * as textHandler from './handlers/text.mjs';

import { writeRowLine, HEADER, validateRow } from '../src/data/csv.js';

// ─── Handler registry ──────────────────────────────

const HANDLERS = [jsHandler, jsonHandler, imageHandler, markdownHandler];
const FALLBACK = textHandler;

const EXT_INDEX = new Map();
for (const h of HANDLERS) {
  for (const ext of h.extensions || []) EXT_INDEX.set(ext, h);
}

/**
 * Pick a handler for a file based on extension.
 * @param {string} filePath
 */
export function handlerFor(filePath) {
  return EXT_INDEX.get(extname(filePath).toLowerCase()) || FALLBACK;
}

// ─── Ignore filters ────────────────────────────────

const DEFAULT_IGNORES = new Set([
  'node_modules', '.git', '.DS_Store', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.parcel-cache', 'test-results',
  '.claude', '.idea', '.vscode',
]);

// History/snapshot files would create a feedback loop if scanned in.
const IGNORE_BASENAMES = new Set([
  'history.csv', 'snapshot.csv', 'package-lock.json',
]);

function shouldIgnore(name) {
  if (DEFAULT_IGNORES.has(name)) return true;
  if (IGNORE_BASENAMES.has(name)) return true;
  if (name.startsWith('.')) return false; // allow .gitignore etc.
  return false;
}

// ─── Walking ───────────────────────────────────────

/**
 * Walk a directory tree, yielding {abs, rel, isDir} for every entry that
 * survives the ignore filter.
 *
 * @param {string} root - absolute root path
 */
export function* walk(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs) || entry.name;
      if (entry.isDirectory()) {
        yield { abs, rel, isDir: true };
        stack.push(abs);
      } else if (entry.isFile()) {
        yield { abs, rel, isDir: false };
      }
    }
  }
}

// ─── Scanning ──────────────────────────────────────

/**
 * Scan a single file and return its untimestamped {nodes, edges}.
 * Always also emits a directory→file `contains` edge to the immediate parent.
 *
 * @param {string} absPath
 * @param {string} rootPath
 * @returns {{nodes:Array,edges:Array}}
 */
export function scanFile(absPath, rootPath) {
  const relPath = relative(rootPath, absPath);
  const handler = handlerFor(absPath);
  let result;
  try {
    result = handler.handle(absPath, relPath);
  } catch (err) {
    // Never let a producer crash the scan — fall back to a bare file node.
    result = FALLBACK.handle(absPath, relPath);
    result.nodes[0].payload = { ...(result.nodes[0].payload || {}), error: err.message };
  }
  // Wire to parent directory.
  const parent = dirname(relPath);
  if (parent && parent !== '.' && parent !== '') {
    const dirId = `dir:${parent}`;
    const fileId = `file:${relPath}`;
    result.edges.push({
      id: `${dirId}->contains->${fileId}`,
      source: dirId,
      target: fileId,
      layer: 'contains',
      weight: 2,
    });
  }
  return result;
}

/**
 * Walk the repo and return validated, timestamped HistoryRow[].
 *
 * @param {string} [root='.']
 * @returns {Array}
 */
export function scanRepo(root = '.') {
  const absRoot = resolve(root);
  const collected = [];
  const seen = new Set();
  const dirs = new Set();

  function pushNode(n) {
    const key = `NODE::${n.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    collected.push({ type: 'NODE', op: 'add', ...n });
  }
  function pushEdge(e) {
    const key = `EDGE::${e.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    collected.push({
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

  // Root project node.
  const rootName = basename(absRoot);
  const rootId = `dir:.`;
  pushNode({
    id: rootId,
    kind: 'directory',
    label: rootName,
    payload: { path: '.', isRoot: true },
  });
  dirs.add('.');

  for (const entry of walk(absRoot)) {
    if (entry.isDir) {
      const id = `dir:${entry.rel}`;
      pushNode({
        id,
        kind: 'directory',
        label: basename(entry.rel),
        payload: { path: entry.rel },
      });
      dirs.add(entry.rel);
      // Parent → child contains edge.
      const parent = dirname(entry.rel);
      const parentId = parent === '.' || parent === '' ? rootId : `dir:${parent}`;
      pushEdge({
        id: `${parentId}->contains->${id}`,
        source: parentId,
        target: id,
        layer: 'contains',
        weight: 2,
      });
    } else {
      const { nodes, edges } = scanFile(entry.abs, absRoot);
      // If the parent directory wasn't yielded yet (file at root), connect to root.
      const parent = dirname(entry.rel);
      if (parent === '.' || parent === '') {
        pushEdge({
          id: `${rootId}->contains->file:${entry.rel}`,
          source: rootId,
          target: `file:${entry.rel}`,
          layer: 'contains',
          weight: 2,
        });
      }
      for (const n of nodes) pushNode(n);
      for (const e of edges) pushEdge(e);
    }
  }

  // Stamp + validate.
  const out = [];
  let t = 0;
  for (const r of collected) {
    const stamped = { ...r, t: t++ };
    const err = validateRow(stamped);
    if (err) continue;
    out.push(stamped);
  }
  return out;
}

// ─── CLI ───────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const positional = args.filter(a => !a.startsWith('--'));
  const root = resolve(positional[0] || '.');
  const rows = scanRepo(root);

  const text = [HEADER, ...rows.map(writeRowLine)].join('\n') + '\n';

  if (outIdx !== -1) {
    const outPath = resolve(args[outIdx + 1]);
    const dir = dirname(outPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, text, 'utf-8');
    console.error(`[repo-scanner] wrote ${rows.length} rows → ${outPath}`);
  } else {
    process.stdout.write(text);
  }
}
