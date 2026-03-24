#!/usr/bin/env node
// Graph generator: AST analysis + codemap → nodes.csv + edges.csv
// Usage: node codegen/graphgen.mjs [inspect.json path]
//
// Reads source code and codemap, produces runtime/nodes.csv and runtime/edges.csv.
// Can be run standalone or imported by the server for watch-triggered regeneration.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

// ── Config ───────────────────────────────────────────
const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_INSPECT = join(ROOT, 'inspect.json');

// ── Codemap parsing ──────────────────────────────────
function parseCodemap(md) {
  const sections = new Map();       // sectionName → [funcNames]
  const importance = new Map();     // funcName → number
  let currentSection = null;
  let isUserCluster = false;
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const secMatch = line.match(/^## (.+)/);
    if (secMatch) {
      currentSection = secMatch[1].trim();
      if (currentSection === 'Controls' || currentSection === 'Constants') { currentSection = null; continue; }
      isUserCluster = (lines[i + 1] || '').trim() === '<!-- user-cluster -->';
      if (isUserCluster) {
        i++; // skip marker
      }
      if (!sections.has(currentSection)) sections.set(currentSection, []);
      continue;
    }
    if (!currentSection) continue;
    const funcMatch = line.match(/^- `(\w+)`/);
    if (funcMatch) {
      const name = funcMatch[1];
      if (sections.has(currentSection)) {
        sections.get(currentSection).push(name);
      }
      const impMatch = line.match(/importance:(\d+)/);
      if (impMatch) importance.set(name, parseInt(impMatch[1]));
    }
  }
  return { sections, importance };
}

// ── JS extraction from HTML ──────────────────────────
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

// ── AST analysis ─────────────────────────────────────
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
      if (parent && parent.type === 'UpdateExpression') {
        writes.add(name);
      } else {
        reads.add(name);
      }
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
        if (parent && parent.type === 'AssignmentExpression' && parent.left === node) {
          writes.add(name);
        } else {
          reads.add(name);
        }
      }
    },
  });

  const rw = new Set();
  for (const n of reads) { if (writes.has(n)) rw.add(n); }
  for (const n of rw) { reads.delete(n); writes.delete(n); }

  return { params, locals, reads, writes, rw, calls, line: 0, endLine: 0, lines: 0 };
}

function analyzeCode(code, lineOffset) {
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'script',
      locations: true,
      allowImportExportEverywhere: true,
    });
  } catch (e) {
    console.error('Parse error:', e.message);
    return null;
  }

  const globals = new Map();
  const functions = new Map();

  // Pass 1: collect top-level declarations
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

  // Pass 2: analyze each function
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      const info = analyzeFunction(node, globals);
      info.line = node.loc.start.line + lineOffset;
      info.endLine = node.loc.end.line + lineOffset;
      info.lines = info.endLine - info.line + 1;
      functions.set(node.id.name, info);
    }
  }

  return { globals, functions };
}

// ── Edge computation ─────────────────────────────────
function computeEdges(functions, importance) {
  const edges = [];
  const names = [...functions.keys()];

  for (let i = 0; i < names.length; i++) {
    const a = functions.get(names[i]);
    for (let j = i + 1; j < names.length; j++) {
      const b = functions.get(names[j]);

      // calls
      if (a.calls.has(names[j])) edges.push({ source: names[i], target: names[j], type: 'calls', weight: 3 });
      if (b.calls.has(names[i])) edges.push({ source: names[j], target: names[i], type: 'calls', weight: 3 });

      // calledBy (reverse)
      if (a.calls.has(names[j])) edges.push({ source: names[j], target: names[i], type: 'calledBy', weight: 3 });
      if (b.calls.has(names[i])) edges.push({ source: names[i], target: names[j], type: 'calledBy', weight: 3 });

      // shared state
      const aState = new Set([...a.reads, ...a.writes, ...a.rw]);
      const bState = new Set([...b.reads, ...b.writes, ...b.rw]);
      let sharedCount = 0;
      for (const v of aState) { if (bState.has(v)) sharedCount++; }
      if (sharedCount > 0) edges.push({ source: names[i], target: names[j], type: 'shared', weight: sharedCount });

      // shared writes
      const aWrites = new Set([...a.writes, ...a.rw]);
      const bWrites = new Set([...b.writes, ...b.rw]);
      let sharedWriteCount = 0;
      for (const v of aWrites) { if (bWrites.has(v)) sharedWriteCount++; }
      if (sharedWriteCount > 0) edges.push({ source: names[i], target: names[j], type: 'sharedWrites', weight: sharedWriteCount });

      // importance
      const impA = importance.get(names[i]) || 0;
      const impB = importance.get(names[j]) || 0;
      if (impA >= 7 && impB >= 7) {
        const hasCall = a.calls.has(names[j]) || b.calls.has(names[i]);
        if (hasCall || sharedCount > 0) {
          const w = Math.round(Math.sqrt(impA * impB));
          edges.push({ source: names[i], target: names[j], type: 'importance', weight: w });
        }
      }
    }
  }

  // Hypergraph edges: function → global variable
  const globalUsage = new Map();    // gname → Set of fnames
  const globalWriters = new Map();  // gname → Set of fnames that write
  for (const [fname, info] of functions) {
    const writerSet = new Set([...info.writes, ...info.rw]);
    for (const s of [info.reads, info.writes, info.rw]) {
      for (const g of s) {
        if (!globalUsage.has(g)) globalUsage.set(g, new Set());
        globalUsage.get(g).add(fname);
      }
    }
    for (const g of writerSet) {
      if (!globalWriters.has(g)) globalWriters.set(g, new Set());
      globalWriters.get(g).add(fname);
    }
  }
  for (const [gname, users] of globalUsage) {
    if (users.size < 2 || functions.has(gname)) continue;
    const writers = globalWriters.get(gname) || new Set();
    for (const fname of users) {
      const edgeType = writers.has(fname) ? 'writesTo' : 'uses';
      edges.push({ source: fname, target: gname, type: edgeType, weight: 1 });
    }
  }

  return { edges, globalUsage };
}

// ── CSV generation ───────────────────────────────────
function escapeCSV(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function generateNodesCSV(functions, globals, codemap, importance) {
  const lines = [];
  // Function nodes
  for (const [name, info] of functions) {
    // Find which cluster this function belongs to
    let cluster = '';
    if (codemap) {
      for (const [section, funcs] of codemap) {
        if (funcs.includes(name)) { cluster = section; break; }
      }
    }
    const imp = importance.get(name) || 3;
    lines.push([name, 'function', cluster, imp, info.line].map(escapeCSV).join(','));
  }
  // Global variable nodes (those used by 2+ functions)
  const globalUsage = new Map();
  for (const [fname, info] of functions) {
    for (const s of [info.reads, info.writes, info.rw]) {
      for (const g of s) {
        if (!globalUsage.has(g)) globalUsage.set(g, new Set());
        globalUsage.get(g).add(fname);
      }
    }
  }
  for (const [gname, users] of globalUsage) {
    if (users.size < 2 || functions.has(gname)) continue;
    const gInfo = globals.get(gname);
    const line = gInfo ? gInfo.line : 0;
    lines.push([gname, 'global', '', 1, line].map(escapeCSV).join(','));
  }
  return lines.join('\n') + '\n';
}

function generateEdgesCSV(edges) {
  const lines = [];
  for (const e of edges) {
    lines.push([e.source, e.target, e.type, e.weight].map(escapeCSV).join(','));
  }
  return lines.join('\n') + '\n';
}

// ── Main: generate CSVs from source + codemap ────────
export function generate(inspectPath) {
  inspectPath = inspectPath || DEFAULT_INSPECT;
  const inspectDir = dirname(inspectPath);
  const inspect = JSON.parse(readFileSync(inspectPath, 'utf8'));

  const srcPath = resolve(inspectDir, inspect.src);
  const codemapPath = inspect.codemap ? resolve(inspectDir, inspect.codemap) : null;
  const runtimeDir = join(inspectDir, 'runtime');

  // Read source
  const html = readFileSync(srcPath, 'utf8');
  const { code, lineOffset } = extractJS(html);
  const analysis = analyzeCode(code, lineOffset);
  if (!analysis) {
    console.error('Failed to parse source');
    return null;
  }

  // Read codemap
  let codemap = null;
  let importance = new Map();
  if (codemapPath) {
    try {
      const md = readFileSync(codemapPath, 'utf8');
      const parsed = parseCodemap(md);
      codemap = parsed.sections;
      importance = parsed.importance;
    } catch { /* no codemap, that's fine */ }
  }

  // Compute edges
  const { edges } = computeEdges(analysis.functions, importance);

  // Write CSVs
  mkdirSync(runtimeDir, { recursive: true });
  const nodesCSV = generateNodesCSV(analysis.functions, analysis.globals, codemap, importance);
  const edgesCSV = generateEdgesCSV(edges);

  const nodesPath = join(runtimeDir, 'nodes.csv');
  const edgesPath = join(runtimeDir, 'edges.csv');
  writeFileSync(nodesPath, nodesCSV);
  writeFileSync(edgesPath, edgesCSV);

  const nNodes = nodesCSV.trim().split('\n').length;
  const nEdges = edgesCSV.trim().split('\n').length;
  console.log(`[graphgen] ${nNodes} nodes, ${nEdges} edges → ${nodesPath}, ${edgesPath}`);

  return { nodesPath, edgesPath, nNodes, nEdges };
}

// ── CLI entry point ──────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const inspectPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_INSPECT;
  const result = generate(inspectPath);
  if (!result) process.exit(1);
}
