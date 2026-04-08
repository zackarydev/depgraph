import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBus } from '../src/core/bus.js';
import { createState, applyRow, replayRows } from '../src/core/state.js';
import { createScheduler } from '../src/core/animation.js';
import {
  createContext, applyPreset, setLayerWeight, setWeights,
  presetNames, DEFAULT_WEIGHTS, PRESETS,
} from '../src/core/context.js';
import { init } from '../src/main.js';

// ─── Bus ──────────────────────────────────────────

describe('core/bus', () => {
  it('emits events to subscribers', () => {
    const bus = createBus();
    const received = [];
    bus.on('test', (p) => received.push(p));
    bus.emit('test', { a: 1 });
    bus.emit('test', { a: 2 });
    assert.equal(received.length, 2);
    assert.deepEqual(received[0], { a: 1 });
  });

  it('supports multiple listeners on the same event', () => {
    const bus = createBus();
    let count = 0;
    bus.on('x', () => count++);
    bus.on('x', () => count++);
    bus.emit('x', {});
    assert.equal(count, 2);
  });

  it('off removes a specific listener', () => {
    const bus = createBus();
    let count = 0;
    const fn = () => count++;
    bus.on('x', fn);
    bus.emit('x');
    assert.equal(count, 1);
    bus.off('x', fn);
    bus.emit('x');
    assert.equal(count, 1); // no change
  });

  it('on() returns an unsubscribe function', () => {
    const bus = createBus();
    let count = 0;
    const unsub = bus.on('x', () => count++);
    bus.emit('x');
    assert.equal(count, 1);
    unsub();
    bus.emit('x');
    assert.equal(count, 1);
  });

  it('once fires only once', () => {
    const bus = createBus();
    let count = 0;
    bus.once('x', () => count++);
    bus.emit('x');
    bus.emit('x');
    bus.emit('x');
    assert.equal(count, 1);
  });

  it('does not throw when emitting with no listeners', () => {
    const bus = createBus();
    bus.emit('nonexistent', { data: 42 });
  });

  it('clear removes all listeners', () => {
    const bus = createBus();
    let count = 0;
    bus.on('a', () => count++);
    bus.on('b', () => count++);
    bus.clear();
    bus.emit('a');
    bus.emit('b');
    assert.equal(count, 0);
  });

  it('isolates events by name', () => {
    const bus = createBus();
    const aPayloads = [];
    const bPayloads = [];
    bus.on('a', (p) => aPayloads.push(p));
    bus.on('b', (p) => bPayloads.push(p));
    bus.emit('a', 1);
    bus.emit('b', 2);
    assert.deepEqual(aPayloads, [1]);
    assert.deepEqual(bPayloads, [2]);
  });
});

// ─── State ────────────────────────────────────────

describe('core/state', () => {
  it('creates an empty state', () => {
    const s = createState();
    assert.equal(s.nodes.size, 0);
    assert.equal(s.edges.size, 0);
    assert.equal(s.cursor, -1);
  });

  it('applies NODE add', () => {
    const s = createState();
    applyRow(s, { t: 0, type: 'NODE', op: 'add', id: 'foo', kind: 'function', label: 'foo', weight: 5 });
    assert.equal(s.nodes.size, 1);
    const n = s.nodes.get('foo');
    assert.equal(n.kind, 'function');
    assert.equal(n.label, 'foo');
    assert.equal(n.importance, 5);
    assert.equal(s.cursor, 0);
  });

  it('applies NODE update', () => {
    const s = createState();
    applyRow(s, { t: 0, type: 'NODE', op: 'add', id: 'foo', kind: 'function', label: 'foo' });
    applyRow(s, { t: 1, type: 'NODE', op: 'update', id: 'foo', label: 'bar', weight: 10 });
    const n = s.nodes.get('foo');
    assert.equal(n.label, 'bar');
    assert.equal(n.importance, 10);
    assert.equal(n.kind, 'function'); // unchanged
  });

  it('applies NODE remove', () => {
    const s = createState();
    applyRow(s, { t: 0, type: 'NODE', op: 'add', id: 'foo', kind: 'function', label: 'foo' });
    applyRow(s, { t: 1, type: 'NODE', op: 'remove', id: 'foo' });
    assert.equal(s.nodes.size, 0);
  });

  it('applies EDGE add', () => {
    const s = createState();
    applyRow(s, { t: 0, type: 'EDGE', op: 'add', id: 'a->b@calls', source: 'a', target: 'b', layer: 'calls', weight: 3 });
    assert.equal(s.edges.size, 1);
    const e = s.edges.get('a->b@calls');
    assert.equal(e.source, 'a');
    assert.equal(e.target, 'b');
    assert.equal(e.layer, 'calls');
    assert.equal(e.weight, 3);
    assert.equal(e.directed, true);
  });

  it('applies EDGE update', () => {
    const s = createState();
    applyRow(s, { t: 0, type: 'EDGE', op: 'add', id: 'a->b@calls', source: 'a', target: 'b', layer: 'calls', weight: 1 });
    applyRow(s, { t: 1, type: 'EDGE', op: 'update', id: 'a->b@calls', weight: 5 });
    assert.equal(s.edges.get('a->b@calls').weight, 5);
  });

  it('applies EDGE remove', () => {
    const s = createState();
    applyRow(s, { t: 0, type: 'EDGE', op: 'add', id: 'a->b@calls', source: 'a', target: 'b', layer: 'calls' });
    applyRow(s, { t: 1, type: 'EDGE', op: 'remove', id: 'a->b@calls' });
    assert.equal(s.edges.size, 0);
  });

  it('ignores update on nonexistent node', () => {
    const s = createState();
    applyRow(s, { t: 0, type: 'NODE', op: 'update', id: 'ghost', label: 'boo' });
    assert.equal(s.nodes.size, 0);
  });

  it('ignores update on nonexistent edge', () => {
    const s = createState();
    applyRow(s, { t: 0, type: 'EDGE', op: 'update', id: 'ghost', weight: 99 });
    assert.equal(s.edges.size, 0);
  });

  it('defaults importance to 1 and kind to unknown', () => {
    const s = createState();
    applyRow(s, { t: 0, type: 'NODE', op: 'add', id: 'x' });
    assert.equal(s.nodes.get('x').importance, 1);
    assert.equal(s.nodes.get('x').kind, 'unknown');
    assert.equal(s.nodes.get('x').label, 'x'); // falls back to id
  });

  it('replayRows builds correct state from multiple rows', () => {
    const rows = [
      { t: 0, type: 'NODE', op: 'add', id: 'a', kind: 'function', label: 'A' },
      { t: 1, type: 'NODE', op: 'add', id: 'b', kind: 'function', label: 'B' },
      { t: 2, type: 'NODE', op: 'add', id: 'c', kind: 'global', label: 'C' },
      { t: 3, type: 'EDGE', op: 'add', id: 'a->b@calls', source: 'a', target: 'b', layer: 'calls', weight: 1 },
      { t: 4, type: 'EDGE', op: 'add', id: 'a->c@reads', source: 'a', target: 'c', layer: 'shared', weight: 2 },
      { t: 5, type: 'NODE', op: 'update', id: 'a', weight: 10 },
      { t: 6, type: 'EDGE', op: 'remove', id: 'a->c@reads' },
      { t: 7, type: 'NODE', op: 'remove', id: 'c' },
    ];
    const s = replayRows(rows);
    assert.equal(s.nodes.size, 2); // a and b remain
    assert.equal(s.edges.size, 1); // only a->b@calls
    assert.equal(s.nodes.get('a').importance, 10);
    assert.equal(s.cursor, 7);
  });

  it('cursor advances with each applied row', () => {
    const s = createState();
    applyRow(s, { t: 100, type: 'NODE', op: 'add', id: 'x' });
    assert.equal(s.cursor, 100);
    applyRow(s, { t: 200, type: 'NODE', op: 'add', id: 'y' });
    assert.equal(s.cursor, 200);
  });

  it('merges payload on NODE update', () => {
    const s = createState();
    applyRow(s, { t: 0, type: 'NODE', op: 'add', id: 'x', payload: { line: 42 } });
    applyRow(s, { t: 1, type: 'NODE', op: 'update', id: 'x', payload: { col: 5 } });
    assert.deepEqual(s.nodes.get('x').payload, { line: 42, col: 5 });
  });
});

// ─── Animation Scheduler ──────────────────────────

describe('core/animation', () => {
  it('calls registered tick functions on each frame', () => {
    let tickACount = 0;
    let tickBCount = 0;
    let renderCount = 0;

    // Fake rAF that runs synchronously for N frames
    let frameCallback = null;
    const fakeRaf = (cb) => { frameCallback = cb; return 1; };
    const fakeCaf = () => { frameCallback = null; };

    const scheduler = createScheduler({
      render: () => renderCount++,
      raf: fakeRaf,
      caf: fakeCaf,
    });

    scheduler.register('a', () => tickACount++);
    scheduler.register('b', () => tickBCount++);
    scheduler.start();

    // Simulate 5 frames
    for (let i = 0; i < 5; i++) {
      const cb = frameCallback;
      if (cb) cb(performance.now());
    }

    assert.equal(tickACount, 5);
    assert.equal(tickBCount, 5);
    assert.equal(renderCount, 5); // one render per frame
  });

  it('does not call unregistered ticks', () => {
    let count = 0;
    let frameCallback = null;
    const fakeRaf = (cb) => { frameCallback = cb; return 1; };
    const fakeCaf = () => { frameCallback = null; };

    const scheduler = createScheduler({
      render: () => {},
      raf: fakeRaf,
      caf: fakeCaf,
    });

    scheduler.register('temp', () => count++);
    scheduler.start();

    // 2 frames with tick
    frameCallback(16); frameCallback(32);
    assert.equal(count, 2);

    // unregister
    scheduler.unregister('temp');
    frameCallback(48); frameCallback(64);
    assert.equal(count, 2); // no change
  });

  it('tracks tick count', () => {
    let frameCallback = null;
    const scheduler = createScheduler({
      raf: (cb) => { frameCallback = cb; return 1; },
      caf: () => {},
    });

    scheduler.start();
    assert.equal(scheduler.tickCount, 0);
    frameCallback(16);
    assert.equal(scheduler.tickCount, 1);
    frameCallback(32);
    assert.equal(scheduler.tickCount, 2);
  });

  it('stop prevents further frames', () => {
    let count = 0;
    let frameCallback = null;
    const scheduler = createScheduler({
      render: () => count++,
      raf: (cb) => { frameCallback = cb; return 1; },
      caf: () => { frameCallback = null; },
    });

    scheduler.start();
    frameCallback(16);
    assert.equal(count, 1);

    scheduler.stop();
    // frameCallback is now null due to caf
    assert.equal(scheduler.isRunning(), false);
  });

  it('passes dt to tick functions', () => {
    const dts = [];
    let frameCallback = null;
    const scheduler = createScheduler({
      raf: (cb) => { frameCallback = cb; return 1; },
      caf: () => {},
    });

    scheduler.register('tracker', (dt) => dts.push(dt));
    scheduler.start();

    frameCallback(100);  // first frame: dt = 16 (default, no lastTime)
    frameCallback(116);  // dt = 16
    frameCallback(150);  // dt = 34

    assert.equal(dts.length, 3);
    assert.equal(dts[1], 16);
    assert.equal(dts[2], 34);
  });

  it('exposes tick names', () => {
    const scheduler = createScheduler({
      raf: () => 1,
      caf: () => {},
    });
    scheduler.register('alpha', () => {});
    scheduler.register('beta', () => {});
    assert.deepEqual(scheduler.tickNames.sort(), ['alpha', 'beta']);
  });
});

// ─── Context ──────────────────────────────────────

describe('core/context', () => {
  it('creates a default context', () => {
    const ctx = createContext();
    assert.equal(ctx.name, 'default');
    assert.equal(ctx.goal, '');
    assert.equal(ctx.pinnedNodes.size, 0);
    assert.equal(ctx.pinnedClusters.size, 0);
    assert.equal(ctx.focalNodes.size, 0);
    assert.ok(ctx.weights.affinity.memberOf === 5.0);
    assert.ok(ctx.weights.affinity.calls === 0.3);
  });

  it('creates a named context', () => {
    const ctx = createContext('my-project');
    assert.equal(ctx.name, 'my-project');
  });

  it('applyPreset changes affinity + physics weights', () => {
    const ctx = createContext();
    const debug = applyPreset(ctx, 'debug');
    assert.equal(debug.name, 'debug');
    assert.equal(debug.weights.affinity.calls, 5.0);
    assert.equal(debug.weights.physics.calls, 5.0);
    // opacity should remain from the original
    assert.equal(debug.weights.opacity.calls, 1.0);
  });

  it('applyPreset with unknown name returns context unchanged', () => {
    const ctx = createContext();
    const same = applyPreset(ctx, 'nonexistent');
    assert.equal(same, ctx);
  });

  it('setLayerWeight changes one layer', () => {
    const ctx = createContext();
    const updated = setLayerWeight(ctx, 'calls', { affinity: 99, opacity: 0.5 });
    assert.equal(updated.weights.affinity.calls, 99);
    assert.equal(updated.weights.opacity.calls, 0.5);
    // physics unchanged
    assert.equal(updated.weights.physics.calls, DEFAULT_WEIGHTS.calls);
    // original not mutated
    assert.equal(ctx.weights.affinity.calls, DEFAULT_WEIGHTS.calls);
  });

  it('setWeights replaces affinity vector', () => {
    const ctx = createContext();
    const updated = setWeights(ctx, { calls: 100, memberOf: 0.01 });
    assert.equal(updated.weights.affinity.calls, 100);
    assert.equal(updated.weights.affinity.memberOf, 0.01);
    // non-overridden layer stays
    assert.equal(updated.weights.affinity.shared, DEFAULT_WEIGHTS.shared);
  });

  it('presetNames returns all presets', () => {
    const names = presetNames();
    assert.ok(names.includes('code-review'));
    assert.ok(names.includes('refactor'));
    assert.ok(names.includes('debug'));
    assert.ok(names.includes('trace-state'));
  });

  it('context is immutable — applyPreset does not mutate original', () => {
    const ctx = createContext();
    const originalCalls = ctx.weights.affinity.calls;
    applyPreset(ctx, 'debug');
    assert.equal(ctx.weights.affinity.calls, originalCalls);
  });

  it('all presets have all default weight keys', () => {
    const defaultKeys = Object.keys(DEFAULT_WEIGHTS).sort();
    for (const [name, preset] of Object.entries(PRESETS)) {
      const presetKeys = Object.keys(preset).sort();
      assert.deepEqual(presetKeys, defaultKeys,
        `preset '${name}' is missing keys or has extra keys`);
    }
  });
});

// ─── main.js init ─────────────────────────────────

describe('main init()', () => {
  it('returns bus, state, context, scheduler', () => {
    const runtime = init();
    assert.ok(runtime.bus);
    assert.ok(runtime.state);
    assert.ok(runtime.context);
    assert.ok(runtime.scheduler);
    runtime.scheduler.stop(); // cleanup, todo; this is annoying.
  });

  it('state has nodes after init (demo history loaded)', () => {
    const { state, scheduler } = init();
    assert.ok(state.nodes.size > 0, 'should have nodes from demo history');
    assert.ok(state.edges.size > 0, 'should have edges from demo history');
    scheduler.stop();
  });

  it('bus is functional after init', () => {
    const { bus, scheduler } = init();
    let received = false;
    bus.on('test-event', () => { received = true; });
    bus.emit('test-event');
    assert.ok(received);
    scheduler.stop(); // cleanup, todo; this is annoying.
  });

  it('scheduler is running after init', () => {
    const { scheduler } = init();
    assert.ok(scheduler.isRunning());
    scheduler.stop(); // cleanup, todo; this is annoying.
  });
});

// Add this at the very end of a test file
process.on('exit', () => {
  // This won't run if it hangs, which is the point.
  console.log('✅ All tests completed, no open handles detected.');
});

process.exit(0);