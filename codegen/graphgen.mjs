#!/usr/bin/env node
// Graph generator: AST analysis + codemap → nodes.csv + edges.csv
//
// Reads source code and codemap, produces runtime/nodes.csv and runtime/edges.csv
// with ALL declarations encoded: functions, variables (const/let/var), object
// properties, and function parameters. The UI layer controls visibility.
//
// Usage: node codegen/graphgen.mjs [inspect.json path]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import {
  parseCodemap, extractJS, analyzeCode, computeEdges, escapeCSV,
} from './ast.mjs';

// ── Config ───────────────────────────────────────────
const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_INSPECT = join(ROOT, 'inspect.json');

// ── CSV generation ───────────────────────────────────

function generateNodesCSV(analysis, codemap, importance) {
  const lines = [];
  const { functions, globals, valueNodes, parameterNodes } = analysis;

  // Function nodes
  for (const [name, info] of functions) {
    let cluster = '';
    if (codemap) {
      for (const [section, funcs] of codemap) {
        if (funcs.includes(name)) { cluster = section; break; }
      }
    }
    const imp = importance.get(name) || 3;
    lines.push([name, 'function', cluster, imp, info.line].map(escapeCSV).join(','));
  }

  // Variable nodes — ALL top-level declarations, type = kind (const/let/var)
  for (const [gname, gInfo] of globals) {
    if (functions.has(gname)) continue; // already emitted as function
    lines.push([gname, gInfo.kind, '', 1, gInfo.line].map(escapeCSV).join(','));
  }

  // Value nodes (object properties, init values — deduplicated)
  for (const vn of valueNodes) {
    lines.push([vn.id, vn.type, '', 1, vn.line].map(escapeCSV).join(','));
  }

  // Parameter nodes
  for (const param of parameterNodes) {
    lines.push([param.id, 'parameter', '', 1, param.line].map(escapeCSV).join(','));
  }

  return lines.join('\n') + '\n';
}

function generateEdgesCSV(behavioralEdges, structEdges) {
  const lines = [];
  for (const e of behavioralEdges) {
    lines.push([e.source, e.target, e.type, e.weight].map(escapeCSV).join(','));
  }
  for (const e of structEdges) {
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

  // Compute behavioral edges (calls, shared, hypergraph)
  const behavioralEdges = computeEdges(analysis.functions, analysis.globals, importance);

  // Write CSVs
  mkdirSync(runtimeDir, { recursive: true });

  const nodesCSV = generateNodesCSV(analysis, codemap, importance);
  const edgesCSV = generateEdgesCSV(behavioralEdges, analysis.structEdges);

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
