#!/usr/bin/env node
/**
 * Phase 10b: JavaScript / .mjs AST producer.
 *
 * Reads a JS source file, parses it via Acorn, and emits NODE + EDGE
 * history rows (SPEC §4 schema) describing:
 *
 *   NODE kind=file       — the source file itself
 *   NODE kind=function   — every named function declaration (top-level + nested)
 *   NODE kind=global     — every top-level `const|let|var` binding
 *   EDGE layer=memberOf  — function/global → file
 *   EDGE layer=calls     — caller-fn → callee-fn
 *   EDGE layer=reads     — function → global it reads
 *   EDGE layer=writes    — function → global it writes
 *
 * The producer is **pure**: it returns rows. Writing to `runtime/history.csv`
 * is the orchestrator's job (graphgen.mjs / repo-scanner.mjs).
 *
 * CLI usage:
 *   node codegen/ast.mjs path/to/file.mjs [--json | --csv]
 *
 * @module codegen/ast
 */

import { readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { parse } from 'acorn';
import { simple as walkSimple, ancestor as walkAncestor } from 'acorn-walk';
import { writeRowLine, HEADER } from '../src/data/csv.js';

/**
 * Parse a JS source string into structured nodes/edges/file metadata.
 *
 * @param {string} source - raw JS or .mjs text
 * @param {Object} [opts]
 * @param {string} [opts.filePath] - path used as the file node id
 * @param {string} [opts.fileId] - explicit file node id (overrides filePath)
 * @returns {{ fileId: string, nodes: Array, edges: Array }}
 */
export function parseJS(source, opts = {}) {
  const filePath = opts.filePath || 'inline.js';
  const fileId = opts.fileId || `file:${filePath}`;
  const nodes = [];
  const edges = [];

  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
  } catch (err) {
    return {
      fileId,
      nodes: [{ id: fileId, kind: 'file', label: basename(filePath), payload: { path: filePath, parseError: err.message } }],
      edges: [],
    };
  }

  // File node
  const lineCount = source.split('\n').length;
  nodes.push({
    id: fileId,
    kind: 'file',
    label: basename(filePath),
    payload: { path: filePath, lines: lineCount, language: 'javascript' },
  });

  // Pass 1: collect top-level globals (const/let/var) and top-level functions.
  const globalNames = new Set();
  const functionInfo = new Map(); // name -> {id, line, endLine}

  for (const stmt of ast.body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        if (decl.id.type === 'Identifier') {
          globalNames.add(decl.id.name);
          const id = `${fileId}#${decl.id.name}`;
          nodes.push({
            id,
            kind: 'global',
            label: decl.id.name,
            payload: { file: filePath, line: decl.id.loc.start.line, declKind: stmt.kind },
          });
          edges.push({
            id: `${id}->memberOf->${fileId}`,
            source: id,
            target: fileId,
            layer: 'memberOf',
            weight: 5,
          });
        }
      }
    } else if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      const name = stmt.id.name;
      const id = `${fileId}#${name}`;
      functionInfo.set(name, {
        id,
        line: stmt.loc.start.line,
        endLine: stmt.loc.end.line,
        node: stmt,
      });
    } else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
      const inner = stmt.declaration;
      if (inner.type === 'FunctionDeclaration' && inner.id) {
        const name = inner.id.name;
        const id = `${fileId}#${name}`;
        functionInfo.set(name, {
          id,
          line: inner.loc.start.line,
          endLine: inner.loc.end.line,
          node: inner,
          exported: true,
        });
      } else if (inner.type === 'VariableDeclaration') {
        for (const decl of inner.declarations) {
          if (decl.id.type === 'Identifier') {
            const name = decl.id.name;
            globalNames.add(name);
            const id = `${fileId}#${name}`;
            nodes.push({
              id,
              kind: 'global',
              label: name,
              payload: { file: filePath, line: decl.id.loc.start.line, declKind: inner.kind, exported: true },
            });
            edges.push({
              id: `${id}->memberOf->${fileId}`,
              source: id,
              target: fileId,
              layer: 'memberOf',
              weight: 5,
            });
            // Also handle: export const foo = function/arrow
            if (decl.init && (decl.init.type === 'FunctionExpression' || decl.init.type === 'ArrowFunctionExpression')) {
              functionInfo.set(name, {
                id,
                line: decl.loc.start.line,
                endLine: decl.loc.end.line,
                node: decl.init,
                exported: true,
              });
            }
          }
        }
      }
    }
  }

  // Emit function nodes + memberOf edges
  for (const [name, info] of functionInfo) {
    nodes.push({
      id: info.id,
      kind: 'function',
      label: name,
      payload: {
        file: filePath,
        line: info.line,
        endLine: info.endLine,
        exported: !!info.exported,
      },
    });
    edges.push({
      id: `${info.id}->memberOf->${fileId}`,
      source: info.id,
      target: fileId,
      layer: 'memberOf',
      weight: 5,
    });
  }

  // Pass 2: walk each function body; record calls / reads / writes.
  for (const [name, info] of functionInfo) {
    const callerId = info.id;
    const calls = new Set();
    const reads = new Set();
    const writes = new Set();

    walkAncestor(info.node, {
      CallExpression(call) {
        const callee = call.callee;
        if (callee.type === 'Identifier' && functionInfo.has(callee.name) && callee.name !== name) {
          calls.add(callee.name);
        } else if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
          // Best-effort: a.b() — record only when `b` is a known top-level fn (rare but safe).
          if (functionInfo.has(callee.property.name) && callee.property.name !== name) {
            calls.add(callee.property.name);
          }
        }
      },
      AssignmentExpression(assign) {
        const target = assign.left;
        if (target.type === 'Identifier' && globalNames.has(target.name)) {
          writes.add(target.name);
        }
      },
      UpdateExpression(upd) {
        if (upd.argument.type === 'Identifier' && globalNames.has(upd.argument.name)) {
          writes.add(upd.argument.name);
        }
      },
      Identifier(idNode, ancestors) {
        if (!globalNames.has(idNode.name)) return;
        // Skip: declaration sites, property keys, the LHS of assignments (already counted as writes).
        const parent = ancestors[ancestors.length - 2];
        if (!parent) return;
        if (parent.type === 'VariableDeclarator' && parent.id === idNode) return;
        if (parent.type === 'MemberExpression' && parent.property === idNode && !parent.computed) return;
        if (parent.type === 'Property' && parent.key === idNode && !parent.computed) return;
        if (parent.type === 'AssignmentExpression' && parent.left === idNode) return;
        reads.add(idNode.name);
      },
    });

    for (const callee of calls) {
      const calleeId = functionInfo.get(callee).id;
      edges.push({
        id: `${callerId}->calls->${calleeId}`,
        source: callerId,
        target: calleeId,
        layer: 'calls',
        weight: 3,
      });
    }
    for (const g of reads) {
      const gid = `${fileId}#${g}`;
      edges.push({
        id: `${callerId}->reads->${gid}`,
        source: callerId,
        target: gid,
        layer: 'reads',
        weight: 1,
      });
    }
    for (const w of writes) {
      const gid = `${fileId}#${w}`;
      edges.push({
        id: `${callerId}->writes->${gid}`,
        source: callerId,
        target: gid,
        layer: 'writes',
        weight: 2,
      });
    }
  }

  return { fileId, nodes, edges };
}

/**
 * Convert parseJS output into a list of HistoryRow objects (without `t` —
 * the orchestrator assigns timestamps).
 *
 * @param {{nodes:Array,edges:Array}} parsed
 * @returns {Array}
 */
export function toHistoryRows(parsed) {
  const rows = [];
  for (const n of parsed.nodes) {
    rows.push({
      type: 'NODE',
      op: 'add',
      id: n.id,
      kind: n.kind,
      label: n.label,
      weight: n.importance ?? 3,
      payload: n.payload || null,
    });
  }
  for (const e of parsed.edges) {
    rows.push({
      type: 'EDGE',
      op: 'add',
      id: e.id,
      source: e.source,
      target: e.target,
      layer: e.layer,
      weight: e.weight ?? 1,
      payload: e.payload || null,
    });
  }
  return rows;
}

/**
 * Parse a file from disk → history rows.
 * @param {string} filePath
 * @param {Object} [opts]
 * @returns {Array}
 */
export function rowsForFile(filePath, opts = {}) {
  const source = readFileSync(filePath, 'utf-8');
  const fileId = opts.fileId || `file:${opts.relPath || filePath}`;
  const parsed = parseJS(source, { filePath: opts.relPath || filePath, fileId });
  return toHistoryRows(parsed);
}

// ─── CLI ───────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node codegen/ast.mjs <file.js> [--json|--csv]');
    process.exit(1);
  }
  const file = resolve(args[0]);
  const fmt = args.includes('--json') ? 'json' : 'csv';
  const rows = rowsForFile(file, { relPath: relative(process.cwd(), file) });
  if (fmt === 'json') {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(HEADER);
    let t = 0;
    for (const r of rows) console.log(writeRowLine({ ...r, t: t++ }));
  }
}
