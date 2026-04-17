/**
 * Moment dispatcher: the minimum runtime substrate.
 *
 * Holds live moments, routes them to registered rules, and on each frame
 * collects contributions (position deltas, future: state deltas) and
 * applies them. Retracted/committed moments are archived to `log`.
 *
 * The whole idea of the substrate is that adding a new interaction becomes
 * "register a rule and emit moments," not "wire a new scheduler tick +
 * bespoke state object + per-interaction handler." If the substrate is
 * real, each rule is ~30 lines and the dispatcher never changes.
 *
 * Rule contract:
 *   rule.name: string
 *   rule.tick(moment, ctx): { posDeltas?: Map<id, {dx,dy}> } | null
 *   rule.onEmit?(moment): void
 *   rule.onRetract?(moment): void
 *   rule.onCommit?(moment): void
 *
 * @module core/dispatcher
 */

import { createHLC } from './clock.js';
import { createMoment, retractMoment, commitMoment } from './moment.js';

/**
 * @typedef {Object} Dispatcher
 * @property {Map<string, Rule>} rules
 * @property {Map<string, import('./moment.js').Moment>} live
 * @property {import('./moment.js').Moment[]} log - retracted/committed moments
 * @property {ReturnType<typeof createHLC>} clock
 */

/**
 * @param {Object} [opts]
 * @param {string} [opts.producerId]
 * @returns {Dispatcher}
 */
export function createDispatcher(opts = {}) {
  return {
    rules: new Map(),
    live: new Map(),
    log: [],
    clock: createHLC(opts.producerId || 'ui'),
  };
}

/**
 * Register a rule. Rules are addressed by name when emitting moments.
 * @param {Dispatcher} d
 * @param {Object} rule
 */
export function registerRule(d, rule) {
  if (!rule || typeof rule.name !== 'string') {
    throw new Error('Rule must have a string name');
  }
  if (typeof rule.tick !== 'function') {
    throw new Error(`Rule ${rule.name} must define tick(moment, ctx)`);
  }
  d.rules.set(rule.name, rule);
}

/**
 * Emit a moment: instantiate a rule over a set of members with a payload.
 * @param {Dispatcher} d
 * @param {Object} spec
 * @returns {import('./moment.js').Moment}
 */
export function emit(d, spec) {
  const rule = d.rules.get(spec.rule);
  if (!rule) throw new Error(`Unknown rule: ${spec.rule}`);

  const id = `m:${d.clock.next()}`;
  const m = createMoment({
    id,
    rule: spec.rule,
    members: spec.members,
    payload: spec.payload,
    author: spec.author,
    tx: spec.tx,
    causes: spec.causes,
    clock: d.clock.snapshot(),
  });
  d.live.set(m.id, m);
  if (rule.onEmit) rule.onEmit(m);
  return m;
}

/**
 * Retract a live moment. Its rule stops contributing on the next tick.
 * @param {Dispatcher} d
 * @param {string} id
 * @returns {import('./moment.js').Moment|null}
 */
export function retract(d, id) {
  const m = d.live.get(id);
  if (!m) return null;
  const rule = d.rules.get(m.rule);
  retractMoment(m);
  d.live.delete(id);
  d.log.push(m);
  if (rule && rule.onRetract) rule.onRetract(m);
  return m;
}

/**
 * Commit a live moment (final, archived). Used for one-shot rules that
 * apply once and then archive (e.g. 'user-move', 'spawn').
 * @param {Dispatcher} d
 * @param {string} id
 */
export function commit(d, id) {
  const m = d.live.get(id);
  if (!m) return null;
  const rule = d.rules.get(m.rule);
  commitMoment(m);
  d.live.delete(id);
  d.log.push(m);
  if (rule && rule.onCommit) rule.onCommit(m);
  return m;
}

/**
 * Per-frame tick: call every live rule, sum their contributions, apply.
 *
 * @param {Dispatcher} d
 * @param {number} dt - ms since last tick
 * @param {Object} ctx - { posMap, edges, ... } passed to rules
 * @returns {{ moved: string[], posDeltas: Map<string, {dx,dy}> }}
 */
export function tick(d, dt, ctx) {
  const posDeltas = new Map();

  for (const [, m] of d.live) {
    if (m.state !== 'live') continue;
    const rule = d.rules.get(m.rule);
    if (!rule) continue;
    const out = rule.tick(m, { ...ctx, dt });
    if (!out) continue;
    if (out.posDeltas) {
      for (const [id, delta] of out.posDeltas) {
        const acc = posDeltas.get(id);
        if (acc) {
          acc.dx += delta.dx;
          acc.dy += delta.dy;
        } else {
          posDeltas.set(id, { dx: delta.dx, dy: delta.dy });
        }
      }
    }
  }

  const moved = [];
  if (ctx && ctx.posMap) {
    for (const [id, delta] of posDeltas) {
      const ps = ctx.posMap.positions.get(id);
      if (!ps || ps.locked) continue;
      ps.x += delta.dx;
      ps.y += delta.dy;
      moved.push(id);
    }
  }

  return { moved, posDeltas };
}

/**
 * Query live moments, optionally filtered by rule name.
 * @param {Dispatcher} d
 * @param {string} [ruleName]
 * @returns {import('./moment.js').Moment[]}
 */
export function liveMoments(d, ruleName) {
  if (!ruleName) return [...d.live.values()];
  const out = [];
  for (const [, m] of d.live) if (m.rule === ruleName) out.push(m);
  return out;
}
