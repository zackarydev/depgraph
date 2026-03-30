// codegen/ast.mjs — Shared AST analysis for graphgen and historygen
//
// Central module for parsing source code into a full hypergraph representation.
// Both graphgen (static CSV) and historygen (tick-ordered streaming CSV) import
// from here to avoid duplication.
//
// The analysis captures ALL declarations: functions, variables (const/let/var),
// object property structure, function parameters, and call-site arguments.
// No filtering is applied — the UI layer decides what to show.

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

// ── Codemap parsing ────────────��─────────────────────

export function parseCodemap(md) {
  const sections = new Map();
  const importance = new Map();
  let currentSection = null;
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const secMatch = line.match(/^## (.+)/);
    if (secMatch) {
      currentSection = secMatch[1].trim();
      if (currentSection === 'Controls' || currentSection === 'Constants') {
        currentSection = null;
        continue;
      }
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

// ── JS extraction from HTML ──────────────────────────

export function extractJS(html) {
  const match = html.match(/<script(?:\s+type="module")?>([\s\S]*)<\/script>/);
  if (!match) return { code: '', lineOffset: 0 };
  const tagStart = html.indexOf(match[0]);
  const lineOffset = html.substring(0, tagStart).split('\n').length;
  const code = match[1]
    .replace(/^\s*import\s+.*$/gm, '/* import */')
    .replace(/^\s*export\s+.*$/gm, '/* export */');
  return { code, lineOffset };
}

// ── CSV utility ──────────��───────────────────────────

export function escapeCSV(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── AST helpers ──────────────────────────────────────

export function collectDeclNames(pattern) {
  const names = [];
  if (pattern.type === 'Identifier') names.push(pattern.name);
  else if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach(p => names.push(...collectDeclNames(p.value || p.key)));
  } else if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach(e => e && names.push(...collectDeclNames(e)));
  }
  return names;
}

// ── Source text → single-line node ID ────────────────

function sourceId(code, start, end) {
  return code.slice(start, end).replace(/\s+/g, ' ').trim();
}

// ── Value node type from AST ──���──────────────────────

function valueNodeType(astNode) {
  switch (astNode.type) {
    case 'Literal':
      if (astNode.value === null) return 'null';
      if (astNode.regex) return 'regex';
      return typeof astNode.value; // 'number', 'string', 'boolean'
    case 'TemplateLiteral': return 'string';
    case 'NewExpression': return 'new';
    case 'ArrayExpression': return 'array';
    case 'ArrowFunctionExpression':
    case 'FunctionExpression': return 'arrow';
    case 'ObjectExpression': return 'object';
    case 'Identifier': return 'ref';
    default: return 'expression';
  }
}

// ── Object structure analysis ────────────────────────
// Recursively walks ObjectExpression nodes. Each property value gets its own
// unique node (id = path like "parent.key"). No deduplication — each
// declaration site is a distinct node. Keys become edge labels.

function analyzeObjectStructure(objNode, parentId, lineOffset, code) {
  const nodes = [];
  const edges = [];

  for (const prop of objNode.properties) {
    if (prop.type === 'SpreadElement') continue;

    const key = prop.computed
      ? null // skip computed properties like [Symbol.iterator]
      : (prop.key.name ?? prop.key.value);
    if (key == null) continue;

    const childId = `${parentId}.${key}`;
    const line = (prop.loc?.start.line || 0) + lineOffset;

    if (prop.value && prop.value.type === 'ObjectExpression') {
      // Nested object: intermediate node, then recurse
      nodes.push({ id: childId, type: 'object', line });
      edges.push({ source: parentId, target: childId, type: String(key), weight: 1 });
      const sub = analyzeObjectStructure(prop.value, childId, lineOffset, code);
      nodes.push(...sub.nodes);
      edges.push(...sub.edges);
    } else if (prop.value) {
      // Leaf value: unique node per property, type from AST
      const valType = valueNodeType(prop.value);
      nodes.push({ id: childId, type: valType, line });
      edges.push({ source: parentId, target: childId, type: String(key), weight: 1 });
    }
  }

  return { nodes, edges };
}

// ── Variable init value analysis ─────────────────────
// For non-object variable initializers, creates a unique value node
// (id = "varName:init") and an "init" edge from the variable.

function analyzeVariableInit(decl, varName, lineOffset) {
  if (!decl.init) return { nodes: [], edges: [] };
  if (decl.init.type === 'ObjectExpression') return { nodes: [], edges: [] };

  const valId = `${varName}:init`;
  const valType = valueNodeType(decl.init);
  const line = (decl.init.loc?.start.line || 0) + lineOffset;

  return {
    nodes: [{ id: valId, type: valType, line }],
    edges: [{ source: varName, target: valId, type: 'init', weight: 1 }],
  };
}

// ── Function analysis ────────���───────────────────────
// Now also captures call-site arguments for creating argument nodes.

export function analyzeFunction(funcNode, globals, code) {
  const params = new Set();
  const paramList = [];
  funcNode.params.forEach(p => {
    const names = collectDeclNames(p);
    names.forEach(n => {
      params.add(n);
      paramList.push({ name: n, line: p.loc?.start.line || 0 });
    });
  });

  const locals = new Set(params);
  const reads = new Set();
  const writes = new Set();
  const calls = new Set();
  const callSites = []; // {callee, line, args: [{index, text, type, line}]}

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
        const calleeName = node.callee.name;
        calls.add(calleeName);
        // Capture arguments for this call site
        if (code && node.arguments.length > 0) {
          callSites.push({
            callee: calleeName,
            line: node.loc?.start.line || 0,
            args: node.arguments.map((arg, i) => ({
              index: i,
              text: sourceId(code, arg.start, arg.end),
              type: valueNodeType(arg),
              line: arg.loc?.start.line || 0,
            })),
          });
        }
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

  return { params, paramList, locals, reads, writes, rw, calls, callSites, line: 0, endLine: 0, lines: 0 };
}

// ── Full code analysis ───────────────────────────────
//
// Returns:
//   globals:        Map<name, {kind, line, endLine}>
//   functions:      Map<name, {params, paramList, locals, reads, writes, rw, calls, callSites, ...}>
//   valueNodes:     [{id, type, line}]        — unique per declaration site (no dedup)
//   parameterNodes: [{id, type, line, ...}]   — function parameters
//   argumentNodes:  [{id, type, line, ...}]   — call-site arguments (dual of parameters)
//   structEdges:    [{source, target, type, weight}]

export function analyzeCode(code, lineOffset) {
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
  const valueNodes = [];
  const parameterNodes = [];
  const argumentNodes = [];
  const structEdges = [];

  // Pass 1: collect top-level declarations
  for (const node of ast.body) {
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        const names = collectDeclNames(decl.id);
        for (const name of names) {
          globals.set(name, {
            kind: node.kind,
            line: node.loc.start.line + lineOffset,
            endLine: node.loc.end.line + lineOffset,
          });

          if (decl.init) {
            if (decl.init.type === 'ObjectExpression') {
              const struct = analyzeObjectStructure(decl.init, name, lineOffset, code);
              valueNodes.push(...struct.nodes);
              structEdges.push(...struct.edges);
            } else {
              const initResult = analyzeVariableInit(decl, name, lineOffset);
              valueNodes.push(...initResult.nodes);
              structEdges.push(...initResult.edges);
            }
          }
        }
      }
    }
    if (node.type === 'FunctionDeclaration' && node.id) {
      globals.set(node.id.name, {
        kind: 'function',
        line: node.loc.start.line + lineOffset,
      });
    }
  }

  // Pass 2: analyze each function body (with code for argument capture)
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      const info = analyzeFunction(node, globals, code);
      info.line = node.loc.start.line + lineOffset;
      info.endLine = node.loc.end.line + lineOffset;
      info.lines = info.endLine - info.line + 1;
      functions.set(node.id.name, info);

      const callerName = node.id.name;

      // Collect parameters as nodes
      for (const param of info.paramList) {
        const paramId = `${callerName}:${param.name}`;
        parameterNodes.push({
          id: paramId,
          type: 'parameter',
          line: param.line + lineOffset,
          function: callerName,
          name: param.name,
        });
        structEdges.push({
          source: paramId,
          target: callerName,
          type: 'param',
          weight: 1,
        });
      }

      // Collect call-site arguments as nodes (homologous to callee's parameters)
      for (const site of info.callSites) {
        const callLine = site.line + lineOffset;
        for (const arg of site.args) {
          const argId = `${callerName}>${site.callee}@${callLine}:${arg.index}`;
          const argLine = arg.line + lineOffset;
          argumentNodes.push({
            id: argId,
            type: 'argument',
            line: argLine,
            caller: callerName,
            callee: site.callee,
            index: arg.index,
            text: arg.text,
          });
          // Edge: caller → argument node
          structEdges.push({
            source: callerName,
            target: argId,
            type: 'arg',
            weight: 1,
          });
        }
      }
    }
  }

  // Pass 3: create binds edges (argument → parameter) now that all functions are analyzed
  for (const argNode of argumentNodes) {
    const calleeInfo = functions.get(argNode.callee);
    if (!calleeInfo) continue;
    const param = calleeInfo.paramList[argNode.index];
    if (!param) continue;
    const paramId = `${argNode.callee}:${param.name}`;
    structEdges.push({
      source: argNode.id,
      target: paramId,
      type: 'binds',
      weight: 1,
    });
  }

  return { globals, functions, valueNodes, parameterNodes, argumentNodes, structEdges };
}

// ── Edge computation ─���───────────────────────────────
// Computes ALL behavioral edges between nodes. No filtering is applied —
// every global that a function touches gets a hypergraph edge, regardless
// of how many other functions also touch it.
//
// Returns: [{source, target, type, weight}] with string IDs.

export function computeEdges(functions, globals, importance) {
  const edges = [];
  const names = [...functions.keys()];

  for (let i = 0; i < names.length; i++) {
    const a = functions.get(names[i]);
    for (let j = i + 1; j < names.length; j++) {
      const b = functions.get(names[j]);

      // calls + calledBy
      if (a.calls.has(names[j])) {
        edges.push({ source: names[i], target: names[j], type: 'calls', weight: 3 });
        edges.push({ source: names[j], target: names[i], type: 'calledBy', weight: 3 });
      }
      if (b.calls.has(names[i])) {
        edges.push({ source: names[j], target: names[i], type: 'calls', weight: 3 });
        edges.push({ source: names[i], target: names[j], type: 'calledBy', weight: 3 });
      }

      // shared state
      const aState = new Set([...a.reads, ...a.writes, ...a.rw]);
      const bState = new Set([...b.reads, ...b.writes, ...b.rw]);
      let sharedCount = 0;
      for (const v of aState) { if (bState.has(v)) sharedCount++; }
      if (sharedCount > 0) edges.push({ source: names[i], target: names[j], type: 'shared', weight: sharedCount });

      // shared writes (mutation contention)
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

  // Hypergraph edges: function → ALL global variables (no usage-count filter)
  for (const [fname, info] of functions) {
    const writerSet = new Set([...info.writes, ...info.rw]);
    const allTouched = new Set([...info.reads, ...info.writes, ...info.rw]);
    for (const g of allTouched) {
      if (functions.has(g)) continue; // function refs handled by calls edges
      if (!globals.has(g)) continue;  // not a known global
      const edgeType = writerSet.has(g) ? 'writesTo' : 'uses';
      edges.push({ source: fname, target: g, type: edgeType, weight: 1 });
    }
  }

  return edges;
}
