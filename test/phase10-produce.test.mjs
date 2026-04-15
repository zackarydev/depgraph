/**
 * Phase 10: Producers — tests.
 *
 * Covers:
 *   10a — frozen schema: validateRow accepts/rejects correctly
 *   10b — AST producer: parses a tiny JS source, emits the expected nodes/edges
 *   10c — Codemap producer: parses a markdown codemap, emits memberOf rows
 *   10d — graphgen orchestrator: combines AST + codemap, dedupes, validates
 *   10e — historygen: round-trips a state through compaction
 *   10f — repo scanner: walks a temp repo, dispatches to handlers, dedupes
 *   10f — watcher diff: add/update/remove rows from in-memory snapshots
 *
 * All filesystem use is confined to a tmp dir so the suite is hermetic.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateRow, parseCSV } from '../src/data/csv.js';
import { parseJS, toHistoryRows, rowsForFile as rowsForJsFile } from '../codegen/ast.mjs';
import { codemapToRows } from '../codegen/codemap.mjs';
import { generate as graphgenGenerate, writeHistory, appendHistory } from '../codegen/graphgen.mjs';
import { stateToHistoryRows, compactHistory } from '../codegen/historygen.mjs';
import { scanRepo, scanFile, handlerFor } from '../codegen/repo-scanner.mjs';
import { handle as jsonHandle } from '../codegen/handlers/json.mjs';
import { handle as imgHandle } from '../codegen/handlers/image.mjs';
import { handle as mdHandle } from '../codegen/handlers/markdown.mjs';
import { createWatcher, diffHandlerOutput } from '../codegen/watcher.mjs';
import { replayRows } from '../src/core/state.js';

// ─── tmp repo scaffolding ──────────────────────────

let TMP;

before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'phase10-'));
  // js source
  writeFileSync(join(TMP, 'a.mjs'), `
    export const counter = 0;
    let total = 1;
    export function add(x) { total = total + x; return counter; }
    function helper() { return add(2); }
    export function main() { helper(); return total; }
  `);
  // package.json
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({
    name: 'tmp', version: '0.0.0',
    scripts: { build: 'echo build', test: 'echo test' },
    dependencies: { acorn: '^8' },
  }, null, 2));
  // markdown
  writeFileSync(join(TMP, 'README.md'), '# Top\n\n## Section A\n\ntext\n\n## Section B\n');
  // image (1 fake byte — we only stat its size)
  writeFileSync(join(TMP, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // nested dir + file
  mkdirSync(join(TMP, 'lib'));
  writeFileSync(join(TMP, 'lib', 'util.mjs'), 'export function noop() {}');
  // codemap
  writeFileSync(join(TMP, 'codemap.md'), `---
name: test
---
## Cluster One
- \`add\`: ~3 importance:5
- \`main\`: ~5 importance:8
## Cluster Two
- \`helper\`: ~4 importance:3
`);
});

after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// ─── 10a. Schema freeze ────────────────────────────

describe('phase10a / schema freeze', () => {
  it('validateRow accepts well-formed NODE add', () => {
    assert.equal(validateRow({ t: 0, type: 'NODE', op: 'add', id: 'a' }), null);
  });
  it('validateRow accepts EDGE add with source/target/layer', () => {
    assert.equal(
      validateRow({ t: 1, type: 'EDGE', op: 'add', id: 'a->b', source: 'a', target: 'b', layer: 'calls' }),
      null
    );
  });
  it('validateRow rejects unknown type', () => {
    assert.match(validateRow({ t: 0, type: 'BLOB', op: 'add', id: 'x' }), /invalid type/);
  });
  it('validateRow rejects unknown op', () => {
    assert.match(validateRow({ t: 0, type: 'NODE', op: 'mutate', id: 'x' }), /invalid op/);
  });
  it('validateRow rejects EDGE add missing endpoints', () => {
    assert.match(validateRow({ t: 0, type: 'EDGE', op: 'add', id: 'x', layer: 'calls' }), /source/);
  });
  it('validateRow rejects missing id', () => {
    assert.match(validateRow({ t: 0, type: 'NODE', op: 'add' }), /missing id/);
  });
});

// ─── 10b. AST producer ─────────────────────────────

describe('phase10b / AST producer', () => {
  it('extracts functions, globals, calls, reads, writes', () => {
    const parsed = parseJS(readFileSync(join(TMP, 'a.mjs'), 'utf-8'), {
      filePath: 'a.mjs',
      fileId: 'file:a.mjs',
    });
    const ids = new Set(parsed.nodes.map(n => n.id));
    assert.ok(ids.has('file:a.mjs'), 'file node present');
    assert.ok(ids.has('file:a.mjs#add'), 'function add present');
    assert.ok(ids.has('file:a.mjs#main'), 'function main present');
    assert.ok(ids.has('file:a.mjs#helper'), 'function helper present');
    assert.ok(ids.has('file:a.mjs#counter'), 'global counter present');
    assert.ok(ids.has('file:a.mjs#total'), 'global total present');

    const callsEdges = parsed.edges.filter(e => e.layer === 'calls');
    const ids2 = callsEdges.map(e => `${e.source}=>${e.target}`);
    assert.ok(ids2.includes('file:a.mjs#main=>file:a.mjs#helper'), 'main → helper call edge');
    assert.ok(ids2.includes('file:a.mjs#helper=>file:a.mjs#add'), 'helper → add call edge');

    const writes = parsed.edges.filter(e => e.layer === 'writes').map(e => e.target);
    assert.ok(writes.includes('file:a.mjs#total'), 'add writes total');

    const reads = parsed.edges.filter(e => e.layer === 'reads').map(e => `${e.source}->${e.target}`);
    assert.ok(reads.some(r => r.endsWith('file:a.mjs#counter')), 'add reads counter');
  });

  it('rowsForFile returns valid rows', () => {
    const rows = rowsForJsFile(join(TMP, 'a.mjs'), { relPath: 'a.mjs' });
    assert.ok(rows.length > 0);
    let t = 0;
    for (const r of rows) {
      assert.equal(validateRow({ ...r, t: t++ }), null, `row ${r.id} valid`);
    }
  });
});

// ─── 10c. Codemap producer ─────────────────────────

describe('phase10c / codemap producer', () => {
  it('emits cluster nodes + memberOf edges', () => {
    const md = readFileSync(join(TMP, 'codemap.md'), 'utf-8');
    const rows = codemapToRows(md);
    const clusters = rows.filter(r => r.type === 'NODE' && r.kind === 'cluster').map(r => r.id);
    assert.deepEqual(clusters.sort(), ['cluster:Cluster One', 'cluster:Cluster Two'].sort());
    const fns = rows.filter(r => r.type === 'NODE' && r.kind === 'function').map(r => r.id);
    assert.deepEqual(fns.sort(), ['add', 'helper', 'main'].sort());
    const memberOfs = rows.filter(r => r.type === 'EDGE' && r.layer === 'memberOf');
    assert.equal(memberOfs.length, 3);
  });
});

// ─── 10d. graphgen orchestrator ────────────────────

describe('phase10d / graphgen orchestrator', () => {
  it('combines AST + codemap, dedupes, stamps t monotonically', () => {
    const rows = graphgenGenerate({
      src: join(TMP, 'a.mjs'),
      codemap: join(TMP, 'codemap.md'),
      root: TMP,
      scan: false,
    });
    assert.ok(rows.length > 0);
    // monotonic t
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].t > rows[i - 1].t, `t increases at ${i}`);
    }
    // every row valid
    for (const r of rows) assert.equal(validateRow(r), null);
    // dedup: only one NODE add per id
    const seen = new Set();
    for (const r of rows.filter(r => r.op === 'add')) {
      const k = `${r.type}::${r.id}`;
      assert.ok(!seen.has(k), `no duplicate ${k}`);
      seen.add(k);
    }
  });

  it('writeHistory + appendHistory write valid CSV', () => {
    const out = join(TMP, 'history.csv');
    const rows = graphgenGenerate({
      src: join(TMP, 'a.mjs'),
      codemap: join(TMP, 'codemap.md'),
      root: TMP,
      scan: false,
    });
    writeHistory(out, rows);
    const text = readFileSync(out, 'utf-8');
    assert.ok(text.startsWith('t,type,op,'));
    const reparsed = parseCSV(text);
    assert.equal(reparsed.length, rows.length);
    // append more
    appendHistory(out, [{
      t: 999999, type: 'NODE', op: 'add', id: 'extra', kind: 'function', label: 'extra',
    }]);
    const text2 = readFileSync(out, 'utf-8');
    assert.ok(text2.includes('extra'));
  });
});

// ─── 10e. historygen replay-pack ───────────────────

describe('phase10e / historygen', () => {
  it('round-trip: state → rows → state has identical primitives', () => {
    const rows = graphgenGenerate({
      src: join(TMP, 'a.mjs'),
      codemap: join(TMP, 'codemap.md'),
      root: TMP,
      scan: false,
    });
    const state = replayRows(rows);
    const compacted = stateToHistoryRows(state);
    const state2 = replayRows(compacted);
    assert.equal(state2.nodes.size, state.nodes.size);
    assert.equal(state2.edges.size, state.edges.size);
    for (const id of state.nodes.keys()) assert.ok(state2.nodes.has(id), id);
    for (const id of state.edges.keys()) assert.ok(state2.edges.has(id), id);
  });

  it('compactHistory drops removed entities', () => {
    const csv = [
      't,type,op,id,kind,source,target,layer,weight,label,payload',
      '0,NODE,add,a,function,,,,1,a,',
      '1,NODE,add,b,function,,,,1,b,',
      '2,NODE,remove,a,,,,,,,',
    ].join('\n') + '\n';
    const rows = compactHistory(csv);
    const ids = rows.map(r => r.id);
    assert.deepEqual(ids, ['b']);
  });
});

// ─── 10f. Repo scanner + handlers ──────────────────

describe('phase10f / repo scanner', () => {
  it('handlerFor picks the right handler by extension', () => {
    assert.equal(handlerFor('foo.mjs').extensions?.includes('.mjs'), true);
    assert.equal(handlerFor('foo.json').extensions?.includes('.json'), true);
    assert.equal(handlerFor('foo.png').extensions?.includes('.png'), true);
    assert.equal(handlerFor('foo.md').extensions?.includes('.md'), true);
    // fallback for unknown ext
    const fallback = handlerFor('foo.unknown');
    assert.equal(fallback.isFallback, true);
  });

  it('json handler exposes package.json scripts as nodes', () => {
    const out = jsonHandle(join(TMP, 'package.json'), 'package.json');
    const scriptIds = out.nodes.filter(n => n.kind === 'script').map(n => n.label);
    assert.deepEqual(scriptIds.sort(), ['build', 'test']);
    const depIds = out.nodes.filter(n => n.kind === 'dependency').map(n => n.label);
    assert.deepEqual(depIds, ['acorn']);
  });

  it('image handler emits a single image node with src payload', () => {
    const out = imgHandle(join(TMP, 'pic.png'), 'pic.png');
    assert.equal(out.nodes.length, 1);
    assert.equal(out.nodes[0].kind, 'image');
    assert.equal(out.nodes[0].payload.src, 'pic.png');
  });

  it('markdown handler emits headings + sibling next-edges', () => {
    const out = mdHandle(join(TMP, 'README.md'), 'README.md');
    const headings = out.nodes.filter(n => n.kind === 'heading').map(n => n.label);
    assert.ok(headings.includes('Top'));
    assert.ok(headings.includes('Section A'));
    assert.ok(headings.includes('Section B'));
    const nextEdges = out.edges.filter(e => e.layer === 'next');
    assert.ok(nextEdges.length >= 1, 'at least one next-edge between sibling H2s');
  });

  it('scanRepo walks the whole tmp repo and dedupes', () => {
    const rows = scanRepo(TMP);
    const ids = new Set(rows.filter(r => r.op === 'add').map(r => `${r.type}::${r.id}`));
    // sanity: every kind we expect is present
    const kinds = new Set(rows.filter(r => r.type === 'NODE').map(r => r.kind));
    assert.ok(kinds.has('directory'), 'directory nodes');
    assert.ok(kinds.has('file') || kinds.has('image'), 'files');
    assert.ok(kinds.has('image'), 'image nodes');
    assert.ok(kinds.has('script'), 'package.json script nodes');
    assert.ok(kinds.has('heading'), 'markdown heading nodes');
    assert.ok(kinds.has('function'), 'js function nodes');
    // every row must validate
    for (const r of rows) assert.equal(validateRow(r), null, `row ${r.id} valid`);
    // dedup
    const seen = new Set();
    for (const r of rows.filter(r => r.op === 'add')) {
      const k = `${r.type}::${r.id}`;
      assert.ok(!seen.has(k), `no duplicate ${k}`);
      seen.add(k);
    }
    // root dir present
    assert.ok(ids.has('NODE::dir:.'));
  });
});

// ─── 10f. Watcher diff ─────────────────────────────

describe('phase10f / watcher diff', () => {
  it('diff: new file → all nodes added', () => {
    const next = { nodes: [{ id: 'n1', kind: 'function', label: 'f', payload: { x: 1 } }], edges: [] };
    const rows = diffHandlerOutput(null, next);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].op, 'add');
    assert.equal(rows[0].id, 'n1');
    assert.equal(rows[0].payload.author, 'watcher');
  });

  it('diff: removed id → remove row', () => {
    const prev = { nodes: [{ id: 'n1', kind: 'function', label: 'f' }], edges: [] };
    const next = { nodes: [], edges: [] };
    const rows = diffHandlerOutput(prev, next);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].op, 'remove');
    assert.equal(rows[0].id, 'n1');
  });

  it('diff: changed payload → update row', () => {
    const prev = { nodes: [{ id: 'n1', kind: 'function', label: 'f', payload: { line: 10 } }], edges: [] };
    const next = { nodes: [{ id: 'n1', kind: 'function', label: 'f', payload: { line: 11 } }], edges: [] };
    const rows = diffHandlerOutput(prev, next);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].op, 'update');
  });

  it('diff: edge weight change → edge update', () => {
    const prev = { nodes: [], edges: [{ id: 'a->b', source: 'a', target: 'b', layer: 'calls', weight: 1 }] };
    const next = { nodes: [], edges: [{ id: 'a->b', source: 'a', target: 'b', layer: 'calls', weight: 5 }] };
    const rows = diffHandlerOutput(prev, next);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].op, 'update');
    assert.equal(rows[0].weight, 5);
  });

  it('createWatcher: feed picks up changes via in-memory snapshot', () => {
    const captured = [];
    const watcher = createWatcher(TMP, { onRows: (rows) => captured.push(...rows) });
    // First feed of an existing file: every node is "new" → all adds
    watcher.feed(join(TMP, 'lib', 'util.mjs'));
    const firstAdds = captured.filter(r => r.op === 'add');
    assert.ok(firstAdds.length > 0, 'first feed emits adds');
    // Re-feed without changes: no diff
    captured.length = 0;
    watcher.feed(join(TMP, 'lib', 'util.mjs'));
    assert.equal(captured.length, 0, 'no diff on identical re-feed');
    // Mutate the file → next feed should emit at least one row
    writeFileSync(join(TMP, 'lib', 'util.mjs'), 'export function noop() {} export function added() {}');
    watcher.feed(join(TMP, 'lib', 'util.mjs'));
    assert.ok(captured.length > 0, 'mutation produces diff rows');
    assert.ok(captured.some(r => r.op === 'add' && r.id.endsWith('#added')));
  });

  it('streaming AST changes: graphgen → watcher emits add+remove rows in sequence', () => {
    // This is the "wow factor" assertion from Phase 10's brief: when the
    // file changes, the user sees the AST delta as live history rows.
    const file = join(TMP, 'live.mjs');
    writeFileSync(file, 'function alpha() {} function beta() {}');
    const captured = [];
    const watcher = createWatcher(TMP, { onRows: (rows) => captured.push(...rows) });
    watcher.feed(file);
    captured.length = 0;
    // Edit: drop beta, add gamma
    writeFileSync(file, 'function alpha() {} function gamma() {}');
    watcher.feed(file);
    const ops = captured.map(r => `${r.op}:${r.id}`);
    assert.ok(ops.some(o => o.startsWith('remove:') && o.includes('#beta')), 'beta removed');
    assert.ok(ops.some(o => o.startsWith('add:') && o.includes('#gamma')), 'gamma added');
  });
});
