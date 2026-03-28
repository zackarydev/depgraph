#!/usr/bin/env node
// History generator: AST analysis → history.csv
//
// Produces a single merged CSV where nodes and edges appear in source-order
// ticks, so the streamer can progressively reveal the graph.
// All declarations are encoded: functions, variables, properties, parameters.
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
import { fileURLToPath } from 'node:url';
import {
  parseCodemap, extractJS, analyzeCode, computeEdges, escapeCSV,
} from './ast.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_INSPECT = join(ROOT, 'inspect.json');

// ── History generation ──────────────────────────────────

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

  const nodes = [];
  const memberOfEdges = [];

  // Cluster nodes at tick 0
  const clusterNames = codemap ? [...codemap.keys()] : [];
  for (const clusterName of clusterNames) {
    nodes.push({ name: clusterName, type: 'cluster', line: 0, importance: 5 });
  }

  // Function → cluster lookup
  const funcToCluster = new Map();
  if (codemap) {
    for (const [section, funcs] of codemap) {
      for (const fname of funcs) funcToCluster.set(fname, section);
    }
  }

  // Function nodes
  for (const [name, info] of analysis.functions) {
    nodes.push({ name, type: 'function', line: info.line, importance: importance.get(name) || 3 });
  }

  // ALL variable nodes — type = kind (const/let/var)
  for (const [gname, gInfo] of analysis.globals) {
    if (analysis.functions.has(gname)) continue;
    nodes.push({ name: gname, type: gInfo.kind, line: gInfo.line, importance: 1 });
  }

  // Value nodes (object properties, init values — deduplicated)
  for (const vn of analysis.valueNodes) {
    nodes.push({ name: vn.id, type: vn.type, line: vn.line, importance: 1 });
  }

  // Parameter nodes
  for (const param of analysis.parameterNodes) {
    nodes.push({ name: param.id, type: 'parameter', line: param.line, importance: 1 });
  }

  // Argument nodes
  for (const arg of analysis.argumentNodes) {
    nodes.push({ name: arg.id, type: 'argument', line: arg.line, importance: 1 });
  }

  // Sort: clusters first (line 0), then by source line
  nodes.sort((a, b) => {
    if (a.type === 'cluster' && b.type !== 'cluster') return -1;
    if (a.type !== 'cluster' && b.type === 'cluster') return 1;
    return a.line - b.line;
  });

  // Assign numeric indices and ticks
  const nameToIdx = new Map();
  nodes.forEach((n, i) => nameToIdx.set(n.name, i));

  const nodeTick = new Map();
  let tick = 0;
  for (let i = 0; i < nodes.length; i++) {
    nodeTick.set(i, nodes[i].type === 'cluster' ? 0 : ++tick);
  }

  // ── Build memberOf edges: function → cluster ──────

  for (const [fname, clusterName] of funcToCluster) {
    const funcIdx = nameToIdx.get(fname);
    const clusterIdx = nameToIdx.get(clusterName);
    if (funcIdx !== undefined && clusterIdx !== undefined) {
      memberOfEdges.push({ label: 'memberOf', source: funcIdx, target: clusterIdx });
    }
  }

  // ── Compute behavioral edges (string IDs → indices) ──

  const behavioralEdges = computeEdges(analysis.functions, analysis.globals, importance);

  const indexedBehavioralEdges = [];
  for (const e of behavioralEdges) {
    const srcIdx = nameToIdx.get(e.source);
    const tgtIdx = nameToIdx.get(e.target);
    if (srcIdx !== undefined && tgtIdx !== undefined) {
      indexedBehavioralEdges.push({ label: e.type, source: srcIdx, target: tgtIdx, weight: e.weight });
    }
  }

  // Map structural edges to indices
  const indexedStructEdges = [];
  for (const e of analysis.structEdges) {
    const srcIdx = nameToIdx.get(e.source);
    const tgtIdx = nameToIdx.get(e.target);
    if (srcIdx !== undefined && tgtIdx !== undefined) {
      indexedStructEdges.push({ label: e.type, source: srcIdx, target: tgtIdx, weight: e.weight });
    }
  }

  // ── Build CSV rows ─────────────────────────────────

  const allEdges = [...memberOfEdges, ...indexedBehavioralEdges, ...indexedStructEdges];
  const rows = [];

  const clusterNameToNum = new Map();
  clusterNames.forEach((c, i) => clusterNameToNum.set(c, i));

  // Emit nodes at their ticks
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const t = nodeTick.get(i);
    const imp = n.importance / 10;
    let clusterNum = '';
    if (n.type === 'cluster') {
      clusterNum = clusterNameToNum.get(n.name) ?? '';
    } else if (funcToCluster.has(n.name)) {
      clusterNum = clusterNameToNum.get(funcToCluster.get(n.name)) ?? '';
    }
    rows.push([t, 'NODE', n.name, i, n.type, imp, clusterNum].map(escapeCSV).join(','));
  }

  // Emit edges at the tick of the later endpoint
  for (const e of allEdges) {
    const t = Math.max(nodeTick.get(e.source), nodeTick.get(e.target));
    rows.push([t, 'EDGE', e.label, e.source, e.target, '', ''].map(escapeCSV).join(','));
  }

  // Sort by tick so streamer can emit in order
  rows.sort((a, b) => {
    const tA = parseInt(a.split(',', 1)[0]);
    const tB = parseInt(b.split(',', 1)[0]);
    if (tA !== tB) return tA - tB;
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

  const nClusters = clusterNames.length;
  console.log(`[historygen] ${nodes.length} nodes (${nClusters} clusters), ${allEdges.length} edges → ${outPath}`);
  return { outPath, nNodes: nodes.length, nEdges: allEdges.length };
}

// ── CLI ──────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const inspectPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_INSPECT;
  const result = generateHistory(inspectPath);
  if (!result) process.exit(1);
}
