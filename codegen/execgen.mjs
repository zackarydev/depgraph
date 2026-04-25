#!/usr/bin/env node
/**
 * Runtime execution hypergraph — hull-driven producer.
 *
 * Emits the smallest interesting execution graph: one addition `A + B = C`,
 * streamed in two phases so the function *loads* first and the invocation
 * *arrives* later. For a real trace there is no reason variables would
 * appear before a function — but this is a test fixture, so the ordering
 * is explicit.
 *
 *   Phase 1 — function definition
 *     fn:add, the three param slots, `of` edges wiring params → fn,
 *     `next-y` edges ordering the params (lhs, rhs, result), and a
 *     single `structural-hyperedge` (hedge:sig:add) grouping them.
 *     In runtime mode this hull is rigid (see gradient.js setRuntimeMode).
 *
 *   Phase 2 — the call
 *     var:{A,B,C}, rt:{A,B,C}, call:add:1, their typed binary edges,
 *     three argument-tether hulls (one per variable's journey across
 *     var → param → rt), and the call-invocation hull.
 *
 * No explicit positions. Layout is emergent from the hypergraph:
 * structural rigidity holds the signature stiff while descent drapes
 * the runtime cells against it via the tethers.
 *
 * Hyperedge heads (abstract cluster targets):
 *   hedge:sig:add       — kind=structural-hyperedge. The signature.
 *                         Rigid in runtime mode.
 *   hedge:arg:{A,B,C}   — kind=hyperedge. Argument tethers.
 *   hedge:call:add:1    — kind=hyperedge. This specific invocation.
 *
 * Binary edges carry the typed relationships:
 *   var → param           layer=arg
 *   param → fn            layer=of
 *   param → rt            layer=runtime
 *   param → param         layer=next-y         (formal argument order)
 *   call → fn             layer=calls
 *   call → rt (inputs)    layer=uses
 *   call → rt (output)    layer=writesTo
 *
 * CLI:
 *   node codegen/execgen.mjs --a 3 --b 4 --out runtime/exec.csv
 *
 * @module codegen/execgen
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeRowLine, HEADER } from '../src/data/csv.js';

/**
 * Build history rows for one addition `a + b = c`.
 *
 * @param {object} opts
 * @param {number} [opts.a=3]
 * @param {number} [opts.b=4]
 * @param {number} [opts.tStart=0]
 * @returns {import('../src/core/types.js').HistoryRow[]}
 */
export function additionToRows({ a = 3, b = 4, tStart = 0 } = {}) {
  const c = a + b;
  const rows = [];
  let t = tStart;

  const node = (id, kind, label, weight = 1) => {
    rows.push({ t: t++, type: 'NODE', op: 'add', id, kind, label, weight });
  };
  const edge = (id, source, target, layer, weight = 1, label) => {
    rows.push({ t: t++, type: 'EDGE', op: 'add', id, source, target, layer, weight, label });
  };
  const memberOf = (member, head, weight = 3) => {
    edge(`m:${member}->${head}`, member, head, 'memberOf', weight);
  };

  // ════════════════════════════════════════════════════════════════
  // Phase 1 — the function definition loads first.
  // ════════════════════════════════════════════════════════════════

  node('fn:add', 'function', '+', 3);

  node('param:add:lhs',    'parameter', 'lhs');
  node('param:add:rhs',    'parameter', 'rhs');
  node('param:add:result', 'parameter', 'result');

  edge('e:param:lhs->fn',    'param:add:lhs',    'fn:add', 'of');
  edge('e:param:rhs->fn',    'param:add:rhs',    'fn:add', 'of');
  edge('e:param:result->fn', 'param:add:result', 'fn:add', 'of');

  edge('e:param:lhs->param:rhs',    'param:add:lhs', 'param:add:rhs',    'next-y');
  edge('e:param:rhs->param:result', 'param:add:rhs', 'param:add:result', 'next-y');

  // Signature hull. Marked `structural-hyperedge` so that when the user
  // flips the Runtime toggle in the UI, gradient.js stiffens its memberOf
  // springs (higher weight → larger force + smaller rest distance).
  node('hedge:sig:add', 'structural-hyperedge', 'add.sig', 1);
  memberOf('fn:add',           'hedge:sig:add', 5);
  memberOf('param:add:lhs',    'hedge:sig:add', 5);
  memberOf('param:add:rhs',    'hedge:sig:add', 5);
  memberOf('param:add:result', 'hedge:sig:add', 5);

  // ════════════════════════════════════════════════════════════════
  // Phase 2 — the invocation arrives. Variables, runtime cells, and the
  // call event attach to the already-settled function structure.
  // ════════════════════════════════════════════════════════════════

  node('var:A', 'variable', 'A');
  node('var:B', 'variable', 'B');
  node('var:C', 'variable', 'C');

  node('rt:A', 'runtime', String(a));
  node('rt:B', 'runtime', String(b));
  node('rt:C', 'runtime', String(c));

  node('call:add:1', 'call', `add(${a},${b})=${c}`, 2);

  edge('e:var:A->param:lhs',    'var:A', 'param:add:lhs',    'arg', 1, 'A');
  edge('e:var:B->param:rhs',    'var:B', 'param:add:rhs',    'arg', 1, 'B');
  edge('e:var:C->param:result', 'var:C', 'param:add:result', 'arg', 1, 'C');

  edge('e:param:lhs->rt:A',    'param:add:lhs',    'rt:A', 'runtime');
  edge('e:param:rhs->rt:B',    'param:add:rhs',    'rt:B', 'runtime');
  edge('e:param:result->rt:C', 'param:add:result', 'rt:C', 'runtime');

  edge('e:call->fn',   'call:add:1', 'fn:add', 'calls');
  edge('e:call->rt:A', 'call:add:1', 'rt:A',   'uses');
  edge('e:call->rt:B', 'call:add:1', 'rt:B',   'uses');
  edge('e:call->rt:C', 'call:add:1', 'rt:C',   'writesTo');

  // Argument tethers: each groups (var, param, rt) so the runtime cell
  // lands near its variable rather than at an independent coordinate.
  node('hedge:arg:A', 'hyperedge', 'arg A', 1);
  memberOf('var:A',         'hedge:arg:A');
  memberOf('param:add:lhs', 'hedge:arg:A');
  memberOf('rt:A',          'hedge:arg:A');

  node('hedge:arg:B', 'hyperedge', 'arg B', 1);
  memberOf('var:B',         'hedge:arg:B');
  memberOf('param:add:rhs', 'hedge:arg:B');
  memberOf('rt:B',          'hedge:arg:B');

  node('hedge:arg:C', 'hyperedge', 'arg C', 1);
  memberOf('var:C',            'hedge:arg:C');
  memberOf('param:add:result', 'hedge:arg:C');
  memberOf('rt:C',             'hedge:arg:C');

  // Call hull: fn + the runtime cells that participated in this call.
  node('hedge:call:add:1', 'hyperedge', 'call#1', 1);
  memberOf('call:add:1', 'hedge:call:add:1');
  memberOf('fn:add',     'hedge:call:add:1');
  memberOf('rt:A',       'hedge:call:add:1');
  memberOf('rt:B',       'hedge:call:add:1');
  memberOf('rt:C',       'hedge:call:add:1');

  return rows;
}

// ─── CLI ───────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const argVal = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
  };

  const a = Number(argVal('--a', '3'));
  const b = Number(argVal('--b', '4'));
  const outPath = argVal('--out', null);

  const rows = additionToRows({ a, b });
  const text = [HEADER, ...rows.map(writeRowLine)].join('\n') + '\n';

  if (outPath) {
    writeFileSync(resolve(outPath), text, 'utf-8');
    console.error(`[execgen] wrote ${rows.length} rows (${a} + ${b} = ${a + b}) → ${outPath}`);
  } else {
    process.stdout.write(text);
  }
}
