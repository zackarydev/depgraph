#!/usr/bin/env node
// History generator: AST analysis → history.csv
//
// Produces a single merged CSV where nodes and edges appear in source-order
// ticks, so the streamer can progressively reveal the graph.
//
// Output format: t,type,label,source,target,importance_xi,cluster
//   NODE rows: t, NODE, <name>,      <nodeIdx>, ,           <importance>, <clusterIdx>
//   EDGE rows: t, EDGE, <edgeLabel>, <srcIdx>,  <tgtIdx>,   ,
//
// Usage:
//   node codegen/historygen.mjs [inspect.json]
//   import { generateHistory } from './codegen/historygen.mjs';

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_INSPECT = join(ROOT, 'inspect.json');

// ── Reused from graphgen: codemap, JS extraction, AST ─

function parseCodemap(md) {
  const sections = new Map();
  const importance = new Map();
  let currentSection = null;
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const secMatch = line.match(/^## (.+)/);
    if (secMatch) {
      currentSection = secMatch[1].trim();
      if (currentSection === 'Controls' || currentSection === 'Constants') { currentSection = null; continue; }
      const isUser = (lines[i + 1] || '').trim() === '<!-- user-cluster -->';
      if (isUser) i++;
      if (!sections.has(currentSection)) sections.set(currentSection, []);
      continue;
    }
    if (!currentSection) continue;
    const funcMatch = line.match(/^- `(\w+)`/);
    if (funcMatch) {
      sections.get(currentSection).push(funcMatch[1]);
      const impMatch = line.match(/importance:(\d+)/);
      if (impMatch) importance.set(funcMatch[1], parseInt(impMatch[1]));
    }
  }
  return { sections, importance };
}

function extractJS(html) {
  const match = html.match(/<script(?:\s+type="module")?>([\s\S]*)<\/script>/);
  if (!match) return { code: '', lineOffset: 0 };
  const tagStart = html.indexOf(match[0]);
  const lineOffset = html.substring(0, tagStart).split('\n').length;
  const code = match[1]
    .replace(/^\s*import\s+.*$/gm, '/* import */')
    .replace(/^\s*export\s+.*$/gm, '/* export */');
  return { code, lineOffset };
}

function collectDeclNames(pattern) {
  const names = [];
  if (pattern.type === 'Identifier') names.push(pattern.name);
  else if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach(p => names.push(...collectDeclNames(p.value || p.key)));
  } else if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach(e => e && names.push(...collectDeclNames(e)));
  }
  return names;
}

function analyzeFunction(funcNode, globals) {
  const params = new Set();
  funcNode.params.forEach(p => collectDeclNames(p).forEach(n => params.add(n)));
  const locals = new Set(params);
  const reads = new Set();
  const writes = new Set();
  const calls = new Set();

  walk.simple(funcNode.body, {
    VariableDeclaration(node) {
      for (const decl of node.declarations) {
        collectDeclNames(decl.id).forEach(n => locals.add(n));
      }
    },
    FunctionDeclaration(node) { if (node.id) locals.add(node.id.name); },
  });

  walk.ancestor(funcNode.body, {
    AssignmentExpression(node) {
      if (node.left.type === 'Identifier') {
        const name = node.left.name;
        if (!locals.has(name) && globals.has(name)) writes.add(name);
      }
    },
    Identifier(node, ancestors) {
      const name = node.name;
      if (locals.has(name) || !globals.has(name)) return;
      const parent = ancestors[ancestors.length - 2];
      if (parent && parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return;
      if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
      if (parent && (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement')) return;
      if (parent && parent.type === 'UpdateExpression') { writes.add(name); }
      else { reads.add(name); }
    },
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && globals.has(node.callee.name)) {
        calls.add(node.callee.name);
      } else if (node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier') {
        const name = node.callee.object.name;
        if (!locals.has(name) && globals.has(name)) reads.add(name);
      }
    },
    MemberExpression(node, ancestors) {
      if (node.object.type === 'Identifier') {
        const name = node.object.name;
        if (locals.has(name) || !globals.has(name)) return;
        const parent = ancestors[ancestors.length - 2];
        if (parent && parent.type === 'AssignmentExpression' && parent.left === node) { writes.add(name); }
        else { reads.add(name); }
      }
    },
  });

  const rw = new Set();
  for (const n of reads) { if (writes.has(n)) rw.add(n); }
  for (const n of rw) { reads.delete(n); writes.delete(n); }

  return { params, locals, reads, writes, rw, calls, line: 0, endLine: 0 };
}

function analyzeCode(code, lineOffset) {
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 2022, sourceType: 'script', locations: true,
      allowImportExportEverywhere: true,
    });
  } catch (e) {
    console.error('Parse error:', e.message);
    return null;
  }

  const globals = new Map();
  const functions = new Map();

  for (const node of ast.body) {
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        collectDeclNames(decl.id).forEach(name => {
          globals.set(name, { kind: node.kind, line: node.loc.start.line + lineOffset });
        });
      }
    }
    if (node.type === 'FunctionDeclaration' && node.id) {
      globals.set(node.id.name, { kind: 'function', line: node.loc.start.line + lineOffset });
    }
  }

  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      const info = analyzeFunction(node, globals);
      info.line = node.loc.start.line + lineOffset;
      info.endLine = node.loc.end.line + lineOffset;
      functions.set(node.id.name, info);
    }
  }

  return { globals, functions };
}

// ── History generation ──────────────────────────────────

function escapeCSV(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function generateHistory(inspectPath) {
  inspectPath = inspectPath || DEFAULT_INSPECT;
  const inspectDir = dirname(inspectPath);
  const inspect = JSON.parse(readFileSync(inspectPath, 'utf8'));

  const srcPath = resolve(inspectDir, inspect.src);
  const codemapPath = inspect.codemap ? resolve(inspectDir, inspect.codemap) : null;
  const runtimeDir = join(inspectDir, 'runtime');

  // Parse source
  const html = readFileSync(srcPath, 'utf8');
  const { code, lineOffset } = extractJS(html);
  const analysis = analyzeCode(code, lineOffset);
  if (!analysis) return null;

  // Parse codemap
  let codemap = null;
  let importance = new Map();
  if (codemapPath) {
    try {
      const md = readFileSync(codemapPath, 'utf8');
      const parsed = parseCodemap(md);
      codemap = parsed.sections;
      importance = parsed.importance;
    } catch { /* no codemap */ }
  }

  // ── Build node list sorted by source line ──────────

  // Collect globals used by 2+ functions (same logic as graphgen)
  const globalUsage = new Map();
  for (const [fname, info] of analysis.functions) {
    for (const s of [info.reads, info.writes, info.rw]) {
      for (const g of s) {
        if (!globalUsage.has(g)) globalUsage.set(g, new Set());
        globalUsage.get(g).add(fname);
      }
    }
  }

  const nodes = [];

  // Functions
  for (const [name, info] of analysis.functions) {
    let cluster = '';
    if (codemap) {
      for (const [section, funcs] of codemap) {
        if (funcs.includes(name)) { cluster = section; break; }
      }
    }
    nodes.push({
      name,
      type: 'function',
      line: info.line,
      importance: importance.get(name) || 3,
      cluster,
    });
  }

  // Shared globals (used by 2+ functions, not themselves functions)
  for (const [gname, users] of globalUsage) {
    if (users.size < 2 || analysis.functions.has(gname)) continue;
    const gInfo = analysis.globals.get(gname);
    nodes.push({
      name: gname,
      type: 'global',
      line: gInfo ? gInfo.line : 0,
      importance: 1,
      cluster: '',
    });
  }

  // Sort by source line
  nodes.sort((a, b) => a.line - b.line);

  // Assign numeric indices and build lookup
  const nameToIdx = new Map();
  nodes.forEach((n, i) => nameToIdx.set(n.name, i));

  // Build cluster name → index mapping
  const clusterNames = [...new Set(nodes.map(n => n.cluster).filter(c => c))];
  const clusterToIdx = new Map();
  clusterNames.forEach((c, i) => clusterToIdx.set(c, i));

  // ── Assign ticks: each node gets a tick based on sorted order ──
  // Edges appear at the tick of whichever endpoint came last.

  const nodeTick = new Map(); // nodeIdx → tick
  nodes.forEach((n, i) => nodeTick.set(i, i));

  // ── Compute edges ─────────────────────────────────
  // Matches graphgen's full edge taxonomy:
  //   calls      — A calls B (directed)
  //   calledBy   — B is called by A (reverse of calls)
  //   shared     — both touch same global, weighted by count
  //   sharedWrites — both write same global (mutation contention)
  //   importance — both high-importance + structurally linked
  //   uses       — function reads a global (hypergraph)
  //   writesTo   — function writes a global (hypergraph)

  const edges = [];
  const funcNames = [...analysis.functions.keys()];

  for (let i = 0; i < funcNames.length; i++) {
    const a = analysis.functions.get(funcNames[i]);
    const aIdx = nameToIdx.get(funcNames[i]);

    for (let j = i + 1; j < funcNames.length; j++) {
      const b = analysis.functions.get(funcNames[j]);
      const bIdx = nameToIdx.get(funcNames[j]);

      // calls + calledBy (directed pairs)
      if (a.calls.has(funcNames[j])) {
        edges.push({ label: 'calls', source: aIdx, target: bIdx });
        edges.push({ label: 'calledBy', source: bIdx, target: aIdx });
      }
      if (b.calls.has(funcNames[i])) {
        edges.push({ label: 'calls', source: bIdx, target: aIdx });
        edges.push({ label: 'calledBy', source: aIdx, target: bIdx });
      }

      // shared state — count all variables both functions touch (reads + writes + rw)
      const aState = new Set([...a.reads, ...a.writes, ...a.rw]);
      const bState = new Set([...b.reads, ...b.writes, ...b.rw]);
      let sharedCount = 0;
      for (const v of aState) { if (bState.has(v)) sharedCount++; }
      if (sharedCount > 0) {
        edges.push({ label: 'shared', source: aIdx, target: bIdx, weight: sharedCount });
      }

      // shared writes — both write the same variable (mutation contention)
      const aWrites = new Set([...a.writes, ...a.rw]);
      const bWrites = new Set([...b.writes, ...b.rw]);
      let sharedWriteCount = 0;
      for (const v of aWrites) { if (bWrites.has(v)) sharedWriteCount++; }
      if (sharedWriteCount > 0) {
        edges.push({ label: 'sharedWrites', source: aIdx, target: bIdx, weight: sharedWriteCount });
      }

      // importance — both high-importance (>=7) with a structural link
      const impA = importance.get(funcNames[i]) || 0;
      const impB = importance.get(funcNames[j]) || 0;
      if (impA >= 7 && impB >= 7) {
        const hasCall = a.calls.has(funcNames[j]) || b.calls.has(funcNames[i]);
        if (hasCall || sharedCount > 0) {
          edges.push({ label: 'importance', source: aIdx, target: bIdx, weight: Math.round(Math.sqrt(impA * impB)) });
        }
      }
    }

    // Hypergraph: function → global variable
    // Match graphgen: writers get 'writesTo', pure readers get 'uses'
    const writerSet = new Set([...a.writes, ...a.rw]);
    const allTouched = new Set([...a.reads, ...a.writes, ...a.rw]);
    for (const g of allTouched) {
      const gIdx = nameToIdx.get(g);
      if (gIdx === undefined) continue;
      edges.push({ label: writerSet.has(g) ? 'writesTo' : 'uses', source: aIdx, target: gIdx });
    }
  }

  // ── Build CSV rows ─────────────────────────────────

  const rows = [];

  // Emit nodes at their ticks
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const t = nodeTick.get(i);
    const clusterIdx = n.cluster ? clusterToIdx.get(n.cluster) : '';
    const imp = n.importance / 10; // normalize to 0-1 range
    rows.push([t, 'NODE', n.name, i, '', imp, clusterIdx].map(escapeCSV).join(','));
  }

  // Emit edges at the tick of the later endpoint
  for (const e of edges) {
    const t = Math.max(nodeTick.get(e.source), nodeTick.get(e.target));
    rows.push([t, 'EDGE', e.label, e.source, e.target, '', ''].map(escapeCSV).join(','));
  }

  // Sort by tick so streamer can emit in order
  rows.sort((a, b) => {
    const tA = parseInt(a.split(',', 1)[0]);
    const tB = parseInt(b.split(',', 1)[0]);
    if (tA !== tB) return tA - tB;
    // Within same tick, nodes before edges
    const typeA = a.split(',')[1];
    const typeB = b.split(',')[1];
    if (typeA !== typeB) return typeA === 'NODE' ? -1 : 1;
    return 0;
  });

  // ── Write output ───────────────────────────────────

  const header = 't,type,label,source,target,importance_xi,cluster';
  const csv = header + '\n' + rows.join('\n') + '\n';

  mkdirSync(runtimeDir, { recursive: true });
  const outPath = join(runtimeDir, 'history.csv');
  writeFileSync(outPath, csv);

  console.log(`[historygen] ${nodes.length} nodes, ${edges.length} edges → ${outPath}`);
  return { outPath, nNodes: nodes.length, nEdges: edges.length };
}

// ── CLI ──────────────────────────────────────────────
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const inspectPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_INSPECT;
  const result = generateHistory(inspectPath);
  if (!result) process.exit(1);
}
