import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEADER, COLUMNS, parseLine, quoteField, writeLine,
  fieldsToRow, rowToFields, parseCSV, writeCSV, writeRowLine, streamLines,
} from '../src/data/csv.js';

import {
  createHistory, load, toCSV, effectiveRows, append,
  moveCursor, stepCursor, switchBranch, listBranches, length,
} from '../src/data/history.js';

import {
  writeSnapshot, loadSnapshot, loadWithTail,
} from '../src/data/snapshot.js';

import { replayRows } from '../src/core/state.js';

// ─── helpers ──────────────────────────────────────

function makeNodeRow(t, id, label) {
  return { t, type: 'NODE', op: 'add', id, kind: 'function', label: label || id };
}

function makeEdgeRow(t, source, target, layer, weight) {
  return {
    t, type: 'EDGE', op: 'add',
    id: `${source}->${target}@${layer}`,
    source, target, layer, weight: weight ?? 1,
  };
}

function generateRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(makeNodeRow(i, `n${i}`, `Node ${i}`));
  }
  return rows;
}

function generateCSV(n) {
  const rows = generateRows(n);
  return writeCSV(rows);
}

// ─── CSV parser ────────��──────────────────────────

describe('data/csv — parseLine', () => {
  it('parses simple unquoted fields', () => {
    assert.deepEqual(parseLine('a,b,c'), ['a', 'b', 'c']);
  });

  it('parses quoted fields', () => {
    assert.deepEqual(parseLine('"hello","world"'), ['hello', 'world']);
  });

  it('handles commas inside quotes', () => {
    assert.deepEqual(parseLine('"a,b",c'), ['a,b', 'c']);
  });

  it('handles escaped quotes (doubled)', () => {
    assert.deepEqual(parseLine('"say ""hello""",done'), ['say "hello"', 'done']);
  });

  it('handles empty fields', () => {
    assert.deepEqual(parseLine('a,,c,'), ['a', '', 'c', '']);
  });

  it('handles the full history header', () => {
    const fields = parseLine(HEADER);
    assert.deepEqual(fields, COLUMNS);
  });

  it('parses a row with JSON payload', () => {
    const line = '0,NODE,add,foo,function,,,,,foo label,"{""line"":42}"';
    const fields = parseLine(line);
    assert.equal(fields[0], '0');
    assert.equal(fields[1], 'NODE');
    assert.equal(fields[3], 'foo');
    assert.equal(fields[10], '{"line":42}');
  });
});

describe('data/csv — quoteField + writeLine', () => {
  it('does not quote simple strings', () => {
    assert.equal(quoteField('hello'), 'hello');
  });

  it('quotes strings with commas', () => {
    assert.equal(quoteField('a,b'), '"a,b"');
  });

  it('quotes and escapes strings with quotes', () => {
    assert.equal(quoteField('say "hi"'), '"say ""hi"""');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(quoteField(null), '');
    assert.equal(quoteField(undefined), '');
  });

  it('writeLine joins with commas', () => {
    assert.equal(writeLine(['a', 'b', 'c']), 'a,b,c');
  });
});

describe('data/csv — fieldsToRow / rowToFields round-trip', () => {
  it('converts fields to a HistoryRow', () => {
    // Legacy 11th `payload` column is silently ignored (migrated to expansion rows).
    const fields = ['42', 'NODE', 'add', 'myNode', 'function', '', '', '', '5', 'My Node', '{"line":10}'];
    const row = fieldsToRow(fields);
    assert.equal(row.t, 42);
    assert.equal(row.type, 'NODE');
    assert.equal(row.op, 'add');
    assert.equal(row.id, 'myNode');
    assert.equal(row.kind, 'function');
    assert.equal(row.weight, 5);
    assert.equal(row.label, 'My Node');
    assert.equal(row.payload, undefined);
  });

  it('round-trips a NODE row through fields', () => {
    const original = {
      t: 7, type: 'NODE', op: 'add', id: 'x',
      kind: 'function', label: 'X func', weight: 3,
    };
    const fields = rowToFields(original);
    const restored = fieldsToRow(fields);
    assert.equal(restored.t, original.t);
    assert.equal(restored.type, original.type);
    assert.equal(restored.id, original.id);
    assert.equal(restored.weight, original.weight);
    assert.equal(restored.label, original.label);
  });

  it('round-trips an EDGE row through fields', () => {
    const original = {
      t: 10, type: 'EDGE', op: 'add', id: 'a->b@calls',
      source: 'a', target: 'b', layer: 'calls', weight: 2,
    };
    const fields = rowToFields(original);
    const restored = fieldsToRow(fields);
    assert.equal(restored.source, 'a');
    assert.equal(restored.target, 'b');
    assert.equal(restored.layer, 'calls');
    assert.equal(restored.weight, 2);
  });

  it('handles missing optional fields gracefully', () => {
    const fields = ['0', 'NODE', 'add', 'x', '', '', '', '', '', '', ''];
    const row = fieldsToRow(fields);
    assert.equal(row.kind, undefined);
    assert.equal(row.payload, undefined);
    assert.equal(row.weight, undefined);
  });
});

describe('data/csv — parseCSV + writeCSV round-trip', () => {
  it('round-trips 100 rows', () => {
    const original = [];
    for (let i = 0; i < 50; i++) {
      original.push(makeNodeRow(i, `n${i}`, `Node ${i}`));
    }
    for (let i = 50; i < 100; i++) {
      original.push(makeEdgeRow(i, `n${i - 50}`, `n${i - 49}`, 'calls', i));
    }

    const csv = writeCSV(original);
    const parsed = parseCSV(csv);

    assert.equal(parsed.length, 100);
    assert.equal(parsed[0].id, 'n0');
    assert.equal(parsed[0].type, 'NODE');
    assert.equal(parsed[50].type, 'EDGE');
    assert.equal(parsed[50].source, 'n0');
    assert.equal(parsed[99].weight, 99);
  });

  it('handles labels with commas and quotes', () => {
    // Payload column was removed from the schema; labels still need to survive
    // CSV round-trip when they contain delimiters and quote chars.
    const rows = [{
      t: 0, type: 'NODE', op: 'add', id: 'tricky',
      kind: 'function', label: 'has, "comma" and quotes',
    }];
    const csv = writeCSV(rows);
    const parsed = parseCSV(csv);
    assert.equal(parsed[0].label, 'has, "comma" and quotes');
  });

  it('round-trips 1000 rows', () => {
    const original = generateRows(1000);
    const csv = writeCSV(original);
    const parsed = parseCSV(csv);
    assert.equal(parsed.length, 1000);
    assert.equal(parsed[999].id, 'n999');
  });
});

describe('data/csv — streamLines', () => {
  it('streams rows one-by-one', () => {
    const csv = generateCSV(20);
    const received = [];
    streamLines(csv, (row) => received.push(row));
    assert.equal(received.length, 20);
    assert.equal(received[0].id, 'n0');
    assert.equal(received[19].id, 'n19');
  });
});

// ─── History ──────────────────────────────────────

describe('data/history — createHistory', () => {
  it('creates empty history', () => {
    const h = createHistory();
    assert.equal(h.cursor, -1);
    assert.equal(h.rows.length, 0);
    assert.equal(h.activeBranch, 'main');
    assert.equal(h.state.nodes.size, 0);
  });
});

describe('data/history — load', () => {
  it('loads 50 rows, cursor at end', () => {
    const csv = generateCSV(50);
    const h = load(csv);
    assert.equal(length(h), 50);
    assert.equal(h.cursor, 49);
    assert.equal(h.state.nodes.size, 50);
    assert.ok(h.state.nodes.has('n0'));
    assert.ok(h.state.nodes.has('n49'));
  });

  it('sets nextT beyond the max timestamp', () => {
    const csv = generateCSV(10);
    const h = load(csv);
    assert.ok(h.nextT >= 10);
  });
});

describe('data/history — moveCursor', () => {
  it('moving cursor to 25 leaves only 26 nodes (indices 0-25)', () => {
    const csv = generateCSV(50);
    const h = load(csv);
    moveCursor(h, 25);
    assert.equal(h.cursor, 25);
    assert.equal(h.state.nodes.size, 26); // rows 0..25
    assert.ok(h.state.nodes.has('n25'));
    assert.ok(!h.state.nodes.has('n26'));
  });

  it('moving cursor to -1 empties state', () => {
    const csv = generateCSV(10);
    const h = load(csv);
    moveCursor(h, -1);
    assert.equal(h.cursor, -1);
    assert.equal(h.state.nodes.size, 0);
  });

  it('moving cursor beyond end clamps to last', () => {
    const csv = generateCSV(10);
    const h = load(csv);
    moveCursor(h, 999);
    assert.equal(h.cursor, 9);
    assert.equal(h.state.nodes.size, 10);
  });

  it('moving cursor to same position is a no-op', () => {
    const csv = generateCSV(10);
    const h = load(csv);
    const result = moveCursor(h, 9);
    assert.equal(result, 9);
  });
});

describe('data/history — stepCursor', () => {
  it('steps backward and forward', () => {
    const csv = generateCSV(10);
    const h = load(csv);
    stepCursor(h, -3);
    assert.equal(h.cursor, 6);
    assert.equal(h.state.nodes.size, 7);

    stepCursor(h, 2);
    assert.equal(h.cursor, 8);
    assert.equal(h.state.nodes.size, 9);
  });
});

describe('data/history — append', () => {
  it('appends a row at the end', () => {
    const csv = generateCSV(5);
    const h = load(csv);
    const row = append(h, { type: 'NODE', op: 'add', id: 'extra', kind: 'function', label: 'Extra' });
    assert.equal(length(h), 6);
    assert.equal(h.cursor, 5);
    assert.ok(h.state.nodes.has('extra'));
    assert.ok(row.t >= 5); // monotonic
  });

  it('assigns monotonic timestamps', () => {
    const h = createHistory();
    const r1 = append(h, { type: 'NODE', op: 'add', id: 'a' });
    const r2 = append(h, { type: 'NODE', op: 'add', id: 'b' });
    const r3 = append(h, { type: 'NODE', op: 'add', id: 'c' });
    assert.ok(r1.t < r2.t);
    assert.ok(r2.t < r3.t);
  });
});

describe('data/history — branching', () => {
  it('appending at mid-cursor creates a branch for the old tail', () => {
    const csv = generateCSV(50);
    const h = load(csv);

    // move cursor to 25 (state has n0..n25)
    moveCursor(h, 25);
    assert.equal(h.state.nodes.size, 26);

    // append a new row — this should branch the old tail (n26..n49)
    append(h, { type: 'NODE', op: 'add', id: 'new-at-25', kind: 'function', label: 'New' });

    // cursor should be at 26 now (rows 0..25 + new row)
    assert.equal(h.cursor, 26);
    assert.equal(h.state.nodes.size, 27); // n0..n25 + new-at-25
    assert.ok(h.state.nodes.has('new-at-25'));
    assert.ok(!h.state.nodes.has('n26')); // old tail is branched away

    // main trunk is now 27 rows
    assert.equal(h.rows.length, 27);

    // a branch should exist with the old tail
    const branches = listBranches(h);
    assert.equal(branches.length, 2); // main + 1 branch
    const tail = branches.find(b => b.id !== 'main');
    assert.ok(tail);
    assert.equal(tail.forkCursor, 25);
  });

  it('can switch to a branch and see its state', () => {
    const csv = generateCSV(50);
    const h = load(csv);

    moveCursor(h, 25);
    append(h, { type: 'NODE', op: 'add', id: 'diverged', kind: 'function', label: 'Diverged' });

    // main now has 27 rows (0..25 + diverged)
    assert.ok(h.state.nodes.has('diverged'));
    assert.ok(!h.state.nodes.has('n49'));

    // switch to the branch (old tail)
    const branches = listBranches(h);
    const branchId = branches.find(b => b.id !== 'main').id;
    switchBranch(h, branchId);

    assert.equal(h.activeBranch, branchId);
    // branch state = rows 0..25 + old tail (n26..n49)
    assert.ok(h.state.nodes.has('n49'));
    assert.ok(h.state.nodes.has('n0'));
    assert.ok(!h.state.nodes.has('diverged'));
    assert.equal(h.state.nodes.size, 50);
  });

  it('can switch back to main after visiting a branch', () => {
    const csv = generateCSV(50);
    const h = load(csv);

    moveCursor(h, 25);
    append(h, { type: 'NODE', op: 'add', id: 'diverged', kind: 'function', label: 'Diverged' });

    const branches = listBranches(h);
    const branchId = branches.find(b => b.id !== 'main').id;

    switchBranch(h, branchId);
    assert.ok(h.state.nodes.has('n49'));

    switchBranch(h, 'main');
    assert.equal(h.activeBranch, 'main');
    assert.ok(h.state.nodes.has('diverged'));
    assert.ok(!h.state.nodes.has('n26')); // n26 was in old tail, now in branch
    assert.equal(h.cursor, 26);
  });

  it('switchBranch to nonexistent returns false', () => {
    const h = createHistory();
    assert.equal(switchBranch(h, 'nonexistent'), false);
  });
});

describe('data/history — toCSV round-trip', () => {
  it('exports then re-imports the same rows', () => {
    const csv = generateCSV(20);
    const h = load(csv);
    append(h, { type: 'NODE', op: 'add', id: 'appended', kind: 'function', label: 'Appended' });

    const exported = toCSV(h);
    const h2 = load(exported);
    assert.equal(h2.state.nodes.size, h.state.nodes.size);
    assert.ok(h2.state.nodes.has('appended'));
  });
});

describe('data/history — effectiveRows', () => {
  it('returns main rows when on main branch', () => {
    const csv = generateCSV(10);
    const h = load(csv);
    assert.equal(effectiveRows(h).length, 10);
  });

  it('returns trunk + branch rows when on a branch', () => {
    const csv = generateCSV(10);
    const h = load(csv);

    moveCursor(h, 4);
    append(h, { type: 'NODE', op: 'add', id: 'new', kind: 'function' });

    const branches = listBranches(h);
    const branchId = branches.find(b => b.id !== 'main').id;
    switchBranch(h, branchId);

    const eff = effectiveRows(h);
    assert.equal(eff.length, 10); // 0..4 from trunk + 5 from old tail
  });
});

// ─── Snapshot ─────────────────────────────────────

describe('data/snapshot — writeSnapshot + loadSnapshot', () => {
  it('round-trips a state through snapshot', () => {
    const rows = [
      makeNodeRow(0, 'a', 'A'),
      makeNodeRow(1, 'b', 'B'),
      makeEdgeRow(2, 'a', 'b', 'calls', 3),
    ];
    const state = replayRows(rows);

    const json = writeSnapshot(state, 2);
    const { state: restored, cursor } = loadSnapshot(json);

    assert.equal(cursor, 2);
    assert.equal(restored.nodes.size, 2);
    assert.equal(restored.edges.size, 1);
    assert.equal(restored.nodes.get('a').label, 'A');
    assert.equal(restored.edges.get('a->b@calls').weight, 3);
  });
});

describe('data/snapshot — loadWithTail', () => {
  it('snapshot + tail equals full replay', () => {
    const allRows = [];
    for (let i = 0; i < 1000; i++) {
      allRows.push(makeNodeRow(i, `n${i}`, `Node ${i}`));
    }

    // full replay
    const fullState = replayRows(allRows);

    // snapshot at 500, tail 501..999
    const halfState = replayRows(allRows.slice(0, 501));
    const snapshot = writeSnapshot(halfState, 500);
    const tailRows = allRows.slice(501);
    const { state: restored } = loadWithTail(snapshot, tailRows);

    // must match
    assert.equal(restored.nodes.size, fullState.nodes.size);
    assert.equal(restored.nodes.size, 1000);
    assert.ok(restored.nodes.has('n0'));
    assert.ok(restored.nodes.has('n999'));
  });

  it('snapshot with empty tail returns snapshot state', () => {
    const rows = [makeNodeRow(0, 'only', 'Only')];
    const state = replayRows(rows);
    const snapshot = writeSnapshot(state, 0);
    const { state: restored, cursor } = loadWithTail(snapshot, []);
    assert.equal(cursor, 0);
    assert.equal(restored.nodes.size, 1);
  });

  it('snapshot at 0 + full tail equals full replay', () => {
    const allRows = generateRows(100);
    const emptyState = replayRows([allRows[0]]);
    const snapshot = writeSnapshot(emptyState, 0);
    const { state: restored } = loadWithTail(snapshot, allRows.slice(1));
    assert.equal(restored.nodes.size, 100);
  });
});

// ─── Integration: history + snapshot ──────────────

describe('integration: history cursor + snapshot', () => {
  it('snapshot at mid-point, load with tail, matches full load', () => {
    const csv = generateCSV(200);
    const hFull = load(csv);

    // simulate snapshot at cursor 100
    moveCursor(hFull, 100);
    const snap = writeSnapshot(hFull.state, 100);

    // reload full, get tail rows
    const hFull2 = load(csv);
    const tailRows = hFull2.rows.slice(101);

    const { state: restored } = loadWithTail(snap, tailRows);
    assert.equal(restored.nodes.size, 200);
    assert.ok(restored.nodes.has('n199'));
  });
});
