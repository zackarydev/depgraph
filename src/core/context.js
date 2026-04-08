/**
 * WorkingContext: weights W, pins, focal, goal; named presets.
 *
 * The context is the observer's reference frame. It determines which
 * layers matter, how strongly each layer attracts, and which clusters
 * are pinned. Changing context cascades: W changes -> affinities
 * recompute -> clusters shift -> hulls redraw -> physics retargets.
 *
 * @module core/context
 */

/** @typedef {import('./types.js').WorkingContext} WorkingContext */
/** @typedef {import('./types.js').LayerWeights} LayerWeights */
/** @typedef {import('./types.js').WeightVector} WeightVector */

/** Default weight vector — starting point, not law. */
const DEFAULT_WEIGHTS = {
  calls: 0.3,
  calledBy: 0.2,
  memberOf: 5.0,
  shared: 0.5,
  sharedWrites: 0.5,
  sharedName: 1.5,
  spatial: 0.1,
};

/**
 * Named presets. Each overrides specific weights; unmentioned layers
 * inherit from DEFAULT_WEIGHTS.
 */
const PRESETS = {
  'code-review': {
    calls: 3.0,
    calledBy: 2.0,
    memberOf: 5.0,
    shared: 0.5,
    sharedWrites: 0.5,
    sharedName: 0.3,
    spatial: 0.1,
  },
  'refactor': {
    calls: 0.5,
    calledBy: 0.5,
    memberOf: 5.0,
    shared: 1.0,
    sharedWrites: 1.5,
    sharedName: 0.5,
    spatial: 1.0,
  },
  'debug': {
    calls: 5.0,
    calledBy: 3.0,
    memberOf: 1.0,
    shared: 2.0,
    sharedWrites: 3.0,
    sharedName: 0.1,
    spatial: 0.1,
  },
  'trace-state': {
    calls: 0.3,
    calledBy: 0.2,
    memberOf: 1.0,
    shared: 5.0,
    sharedWrites: 5.0,
    sharedName: 0.1,
    spatial: 0.1,
  },
};

/**
 * Create a new WorkingContext with defaults.
 * @param {string} [name='default']
 * @returns {WorkingContext}
 */
export function createContext(name = 'default') {
  return {
    name,
    weights: {
      affinity: { ...DEFAULT_WEIGHTS },
      physics: { ...DEFAULT_WEIGHTS },
      opacity: Object.fromEntries(
        Object.keys(DEFAULT_WEIGHTS).map(k => [k, 1.0])
      ),
    },
    pinnedNodes: new Set(),
    pinnedClusters: new Set(),
    pinnedExpanded: new Set(),
    focalNodes: new Set(),
    lensEdgeLayers: new Set(Object.keys(DEFAULT_WEIGHTS)),
    goal: '',
  };
}

/**
 * Apply a named preset to a context, returning a new context.
 * Unrecognized preset names are ignored (returns context unchanged).
 *
 * @param {WorkingContext} context
 * @param {string} presetName
 * @returns {WorkingContext}
 */
export function applyPreset(context, presetName) {
  const preset = PRESETS[presetName];
  if (!preset) return context;

  return {
    ...context,
    name: presetName,
    weights: {
      affinity: { ...DEFAULT_WEIGHTS, ...preset },
      physics: { ...DEFAULT_WEIGHTS, ...preset },
      opacity: { ...context.weights.opacity },
    },
  };
}

/**
 * Set the full weight triplet (affinity, physics, opacity) for a single layer.
 *
 * @param {WorkingContext} context
 * @param {string} layer - e.g. 'calls', 'memberOf'
 * @param {{ affinity?: number, physics?: number, opacity?: number }} values
 * @returns {WorkingContext}
 */
export function setLayerWeight(context, layer, values) {
  const weights = {
    affinity: { ...context.weights.affinity },
    physics: { ...context.weights.physics },
    opacity: { ...context.weights.opacity },
  };
  if (values.affinity != null) weights.affinity[layer] = values.affinity;
  if (values.physics != null) weights.physics[layer] = values.physics;
  if (values.opacity != null) weights.opacity[layer] = values.opacity;

  return { ...context, weights };
}

/**
 * Replace the full affinity weight vector.
 * @param {WorkingContext} context
 * @param {WeightVector} affinityWeights
 * @returns {WorkingContext}
 */
export function setWeights(context, affinityWeights) {
  return {
    ...context,
    weights: {
      ...context.weights,
      affinity: { ...context.weights.affinity, ...affinityWeights },
    },
  };
}

/**
 * Get the list of available preset names.
 * @returns {string[]}
 */
export function presetNames() {
  return Object.keys(PRESETS);
}

/** Exported for testing. */
export { DEFAULT_WEIGHTS, PRESETS };
