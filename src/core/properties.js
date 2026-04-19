/**
 * System-property listener registry.
 *
 * A "property" is a hardcoded-in-JS predicate that classifies nodes as they
 * pass through the service bus. Each registered listener maintains a live
 * Map<id, Node> of matching nodes — the values are references into
 * graph.state.nodes, not copies. Consumers (renderer, spatial index, …) read
 * the listener's map instead of scanning all of state.
 *
 * Listeners are notified per-row via notifyRow(registry, row, state). They
 * decide inclusion using their own bookkeeping (counters, flags) and mutate
 * their own `nodes` map directly.
 *
 * @module core/properties
 */

/**
 * @typedef {Object} PropertySpec
 * @property {string} name
 * @property {(ctx: PropertyCtx) => void} [onNodeAdd]
 * @property {(ctx: PropertyCtx) => void} [onNodeUpdate]
 * @property {(ctx: PropertyCtx) => void} [onNodeRemove]
 * @property {(ctx: PropertyCtx) => void} [onEdgeAdd]
 * @property {(ctx: PropertyCtx) => void} [onEdgeRemove]
 * @property {() => void} [onReset]
 */

/**
 * @typedef {Object} PropertyCtx
 * @property {import('../core/types.js').HistoryRow} row
 * @property {import('./state.js').State} state
 * @property {Map<string, import('./types.js').Node>} nodes - listener-owned set
 */

/**
 * @typedef {Object} PropertyListener
 * @property {string} name
 * @property {Map<string, import('./types.js').Node>} nodes
 * @property {PropertySpec} spec
 */

/**
 * @typedef {Object} PropertyRegistry
 * @property {Map<string, PropertyListener>} listeners
 */

/** @returns {PropertyRegistry} */
export function createPropertyRegistry() {
  return { listeners: new Map() };
}

/**
 * Register a property listener. Idempotent on name: re-registering replaces.
 * @param {PropertyRegistry} registry
 * @param {PropertySpec} spec
 * @returns {PropertyListener}
 */
export function registerProperty(registry, spec) {
  if (!spec || typeof spec.name !== 'string') {
    throw new Error('Property spec must have a string name');
  }
  const listener = { name: spec.name, nodes: new Map(), spec };
  registry.listeners.set(spec.name, listener);
  return listener;
}

/**
 * Look up a registered listener.
 * @param {PropertyRegistry} registry
 * @param {string} name
 * @returns {PropertyListener|null}
 */
export function getProperty(registry, name) {
  return registry.listeners.get(name) || null;
}

/**
 * Notify all listeners about a single applied row.
 * Call AFTER the state has been mutated so listeners see consistent state.
 *
 * @param {PropertyRegistry} registry
 * @param {import('./types.js').HistoryRow} row
 * @param {import('./state.js').State} state
 */
export function notifyRow(registry, row, state) {
  for (const listener of registry.listeners.values()) {
    const ctx = { row, state, nodes: listener.nodes };
    const s = listener.spec;
    if (row.type === 'NODE') {
      if (row.op === 'add' && s.onNodeAdd) s.onNodeAdd(ctx);
      else if (row.op === 'update' && s.onNodeUpdate) s.onNodeUpdate(ctx);
      else if (row.op === 'remove' && s.onNodeRemove) s.onNodeRemove(ctx);
    } else if (row.type === 'EDGE') {
      if (row.op === 'add' && s.onEdgeAdd) s.onEdgeAdd(ctx);
      else if (row.op === 'remove' && s.onEdgeRemove) s.onEdgeRemove(ctx);
    }
  }
}

/**
 * Clear every listener's internal state. Use before a full replay.
 * @param {PropertyRegistry} registry
 */
export function resetProperties(registry) {
  for (const listener of registry.listeners.values()) {
    listener.nodes.clear();
    if (listener.spec.onReset) listener.spec.onReset();
  }
}
