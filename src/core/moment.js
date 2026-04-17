/**
 * Moment: a hyperedge of the graph that is firing right now.
 *
 * A moment binds a `rule` to a set of `members` (node ids) for a duration.
 * While live it contributes to world state (position deltas, state-variable
 * updates, new events) via its rule's tick function. When retracted the
 * contribution stops; when committed the moment is frozen as a record in
 * the moment log.
 *
 * This is the "moment IS a hyperedge" framing: rule-applications are the
 * only primitive of dynamics. A user drag, a runtime state tick, a watcher
 * file-diff, an agent rewrite — all are moments with different rules.
 *
 * @module core/moment
 */

/**
 * @typedef {Object} Moment
 * @property {string} id - unique, includes HLC coord
 * @property {string} rule - rule name
 * @property {string[]} members - participating node/edge ids
 * @property {Object} payload - rule-specific data
 * @property {string} author - 'user' | 'watcher' | 'agent' | 'runtime'
 * @property {string|null} tx - transaction id (atomic group)
 * @property {string[]} causes - prior moment ids this depends on
 * @property {import('./clock.js').HLCCoord} clock
 * @property {'live'|'retracted'|'committed'} state
 * @property {number} createdAt - wallclock ms at emit time
 * @property {number} elapsed - ms since emit (updated by rule tick if relevant)
 */

/**
 * Construct a Moment record.
 * @param {Object} spec
 * @returns {Moment}
 */
export function createMoment(spec) {
  return {
    id: spec.id,
    rule: spec.rule,
    members: [...(spec.members || [])],
    payload: { ...(spec.payload || {}) },
    author: spec.author || 'user',
    tx: spec.tx || null,
    causes: [...(spec.causes || [])],
    clock: spec.clock,
    state: 'live',
    createdAt: Date.now(),
    elapsed: 0,
  };
}

/** @param {Moment} m */
export function retractMoment(m) { m.state = 'retracted'; }

/** @param {Moment} m */
export function commitMoment(m) { m.state = 'committed'; }
