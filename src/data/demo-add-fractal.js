/**
 * Hand-authored fractal demo: the `add` function across abstraction levels.
 *
 *   L0: 1 visible node             "add"
 *   L1: 4 visible nodes            func add | (X, Y) | -> Z | { ... }
 *   L2: 8 visible nodes            statement-level chunks
 *   L3: 18 atomic tokens           every token of the source
 *
 * No new types: every level is a memberOf clustering of the previous. The
 * hierarchy is uniform (every atom sits exactly 3 expansions deep), so the
 * fractal LOD pass can hide everything below the current zoom level by
 * walking memberOf parent edges.
 *
 * Positions are hand-authored to mimic how source code is read on a page:
 * - Top row holds the signature (decl, args, ret) left-to-right.
 * - Body sits below the signature, with one stacked row per statement.
 * Children of a parent cluster are placed inside that parent's footprint
 * so each fractal layer reveals interior structure without disrupting the
 * spatial story of the previous layer.
 *
 * @module data/demo-add-fractal
 */

const POSITIONS = {
  // L0
  'add':            { x:    0, y:    0 },

  // L1: signature row across the top, body below
  'L1_decl':        { x: -300, y: -150 },
  'L1_args':        { x: -100, y: -150 },
  'L1_ret':         { x:  100, y: -150 },
  'L1_body':        { x:    0, y:  120 },

  // L2: each L2 lives within its L1 parent's footprint
  // signature pieces (left to right, on the same row as their L1 parent)
  'L2_func':        { x: -340, y: -150 },
  'L2_name':        { x: -260, y: -150 },
  'L2_args':        { x: -100, y: -150 },
  'L2_arrow_z':     { x:  100, y: -150 },
  // body statements, stacked vertically like code lines
  'L2_brace_l':     { x: -120, y:   30 },
  'L2_assign':      { x:  -40, y:   90 },
  'L2_return':      { x:  -40, y:  150 },
  'L2_brace_r':     { x: -120, y:  210 },

  // L3: atoms inside their L2 parent's footprint
  'tok_func':       { x: -340, y: -150 },
  'tok_add':        { x: -260, y: -150 },
  'tok_paren_l':    { x: -150, y: -150 },
  'tok_X':          { x: -125, y: -150 },
  'tok_comma':      { x: -100, y: -150 },
  'tok_Y':          { x:  -75, y: -150 },
  'tok_paren_r':    { x:  -50, y: -150 },
  'tok_arrow':      { x:   85, y: -150 },
  'tok_Z_ret':      { x:  115, y: -150 },
  'tok_brace_l':    { x: -120, y:   30 },
  'tok_Z_assign':   { x:  -90, y:   90 },
  'tok_eq':         { x:  -65, y:   90 },
  'tok_X_use':      { x:  -40, y:   90 },
  'tok_plus':       { x:  -15, y:   90 },
  'tok_Y_use':      { x:   10, y:   90 },
  'tok_return':     { x:  -65, y:  150 },
  'tok_Z_returned': { x:  -15, y:  150 },
  'tok_brace_r':    { x: -120, y:  210 },
};

export const ADD_FRACTAL_POSITIONS = POSITIONS;

/**
 * @returns {import('../core/types.js').HistoryRow[]}
 */
export function generateAddFractalHistory() {
  const rows = [];
  let t = 0;

  function addNode(id, kind, label, importance) {
    rows.push({ t: t++, type: 'NODE', op: 'add', id, kind, label, weight: importance || 1 });
  }
  function addEdge(source, target, layer, weight) {
    const id = `${source}→${target}@${layer}`;
    rows.push({ t: t++, type: 'EDGE', op: 'add', id, source, target, layer, weight: weight || 1 });
  }
  function memberOf(member, parent) {
    addEdge(member, parent, 'memberOf', 5);
  }

  // ─── L0: the function as a single collapsed unit ───
  // Plain id (not "cluster:add") because deriveClusters' memberOf path
  // double-prefixes targets that already start with "cluster:". The derived
  // cluster id will be `cluster:add`.
  addNode('add', 'cluster', 'add', 6);

  // ─── L1: signature pieces + body, members of cluster:add ───
  addNode('L1_decl', 'cluster', 'func add', 4);
  addNode('L1_args', 'cluster', '(X, Y)',   3);
  addNode('L1_ret',  'cluster', '→ Z',     3);
  addNode('L1_body', 'cluster', 'body',     5);

  memberOf('L1_decl', 'add');
  memberOf('L1_args', 'add');
  memberOf('L1_ret',  'add');
  memberOf('L1_body', 'add');

  // ─── L2: statement-level chunks, members of L1.* ───
  // Every L1 has at least one L2 child so the hierarchy is uniform — atoms
  // are always exactly 3 levels deep regardless of which L1 they belong to.
  addNode('L2_func',     'cluster', 'func',         2);
  addNode('L2_name',     'cluster', 'add',          3);
  addNode('L2_args',     'cluster', '(X, Y)',       3);
  addNode('L2_arrow_z',  'cluster', '→ Z',         3);
  addNode('L2_brace_l',  'cluster', '{',            2);
  addNode('L2_assign',   'cluster', 'Z = X + Y',    4);
  addNode('L2_return',   'cluster', 'return Z',     3);
  addNode('L2_brace_r',  'cluster', '}',            2);

  memberOf('L2_func',    'L1_decl');
  memberOf('L2_name',    'L1_decl');
  memberOf('L2_args',    'L1_args');
  memberOf('L2_arrow_z', 'L1_ret');
  memberOf('L2_brace_l', 'L1_body');
  memberOf('L2_assign',  'L1_body');
  memberOf('L2_return',  'L1_body');
  memberOf('L2_brace_r', 'L1_body');

  // ─── L3: atomic tokens, members of L2.* ───
  // The deepest representation. Every higher level is a clustering of these.
  function atom(id, label) { addNode(id, 'function', label, 1); }
  atom('tok_func',       'func');
  atom('tok_add',        'add');
  atom('tok_paren_l',    '(');
  atom('tok_X',          'X');
  atom('tok_comma',      ',');
  atom('tok_Y',          'Y');
  atom('tok_paren_r',    ')');
  atom('tok_arrow',      '→');
  atom('tok_Z_ret',      'Z');
  atom('tok_brace_l',    '{');
  atom('tok_Z_assign',   'Z');
  atom('tok_eq',         '=');
  atom('tok_X_use',      'X');
  atom('tok_plus',       '+');
  atom('tok_Y_use',      'Y');
  atom('tok_return',     'return');
  atom('tok_Z_returned', 'Z');
  atom('tok_brace_r',    '}');

  memberOf('tok_func',       'L2_func');
  memberOf('tok_add',        'L2_name');
  memberOf('tok_paren_l',    'L2_args');
  memberOf('tok_X',          'L2_args');
  memberOf('tok_comma',      'L2_args');
  memberOf('tok_Y',          'L2_args');
  memberOf('tok_paren_r',    'L2_args');
  memberOf('tok_arrow',      'L2_arrow_z');
  memberOf('tok_Z_ret',      'L2_arrow_z');
  memberOf('tok_brace_l',    'L2_brace_l');
  memberOf('tok_Z_assign',   'L2_assign');
  memberOf('tok_eq',         'L2_assign');
  memberOf('tok_X_use',      'L2_assign');
  memberOf('tok_plus',       'L2_assign');
  memberOf('tok_Y_use',      'L2_assign');
  memberOf('tok_return',     'L2_return');
  memberOf('tok_Z_returned', 'L2_return');
  memberOf('tok_brace_r',    'L2_brace_r');

  // ─── Sequence edges so siblings stay near each other under physics. ───
  function chain(layer, weight, ...ids) {
    for (let i = 0; i + 1 < ids.length; i++) addEdge(ids[i], ids[i + 1], layer, weight);
  }
  chain('shared', 1, 'tok_paren_l', 'tok_X', 'tok_comma', 'tok_Y', 'tok_paren_r');
  chain('shared', 1, 'tok_arrow', 'tok_Z_ret');
  chain('shared', 1, 'tok_Z_assign', 'tok_eq', 'tok_X_use', 'tok_plus', 'tok_Y_use');
  chain('shared', 1, 'tok_return', 'tok_Z_returned');
  chain('shared', 1, 'L2_brace_l', 'L2_assign', 'L2_return', 'L2_brace_r');
  chain('shared', 1, 'L2_func', 'L2_name', 'L2_args', 'L2_arrow_z');
  chain('shared', 1, 'L1_decl', 'L1_args', 'L1_ret', 'L1_body');

  // ─── Binding edges: link every occurrence of the same identifier. ───
  // Without these the L3 atoms are 2× X, 2× Y, 3× Z floating independently.
  // The binds layer carries the data flow: param → use → op → assignment →
  // return → signature output → exit through the closing brace. Runtime
  // value-nodes ride these edges from the call site through the body and
  // back out — they make the function actually executable as a hypergraph.
  function bind(a, b) { addEdge(a, b, 'binds', 1); }
  bind('tok_X',          'tok_X_use');         // param X → body use
  bind('tok_Y',          'tok_Y_use');         // param Y → body use
  bind('tok_plus',       'tok_Z_assign');      // op result → Z (LHS of assign)
  bind('tok_Z_assign',   'tok_Z_returned');    // Z (assigned) → Z (in return)
  bind('tok_Z_returned', 'tok_brace_r');       // exit through closing brace
  bind('tok_brace_r',    'tok_Z_ret');         // bubble up to signature → Z

  return rows;
}
