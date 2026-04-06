/**
 * EDGE_LAYERS registry.
 *
 * Canonical edge layers with their visual properties. New layers
 * register dynamically when unknown types arrive from streams.
 * Each layer has: id, color, dash pattern, directed flag.
 *
 * @module edges/layers
 */

/**
 * @typedef {Object} LayerDef
 * @property {string} id
 * @property {string} color - CSS color
 * @property {string} dash - SVG stroke-dasharray ('' for solid)
 * @property {boolean} directed
 * @property {boolean} visible - whether the layer is currently toggled on
 */

/** @type {Map<string, LayerDef>} */
const EDGE_LAYERS = new Map([
  ['calls',       { id: 'calls',       color: '#4a90d9', dash: '',       directed: true,  visible: true }],
  ['calledBy',    { id: 'calledBy',    color: '#7b68ee', dash: '',       directed: true,  visible: true }],
  ['uses',        { id: 'uses',        color: '#50c878', dash: '4,2',   directed: true,  visible: true }],
  ['writesTo',    { id: 'writesTo',    color: '#e74c3c', dash: '4,2',   directed: true,  visible: true }],
  ['shared',      { id: 'shared',      color: '#f39c12', dash: '2,2',   directed: false, visible: true }],
  ['sharedWrites',{ id: 'sharedWrites',color: '#e67e22', dash: '2,2',   directed: false, visible: true }],
  ['sharedName',  { id: 'sharedName',  color: '#9b59b6', dash: '6,3',   directed: false, visible: true }],
  ['importance',  { id: 'importance',  color: '#1abc9c', dash: '',       directed: false, visible: true }],
  ['memberOf',    { id: 'memberOf',    color: '#95a5a6', dash: '8,4',   directed: true,  visible: true }],
  ['spatial',     { id: 'spatial',     color: '#bdc3c7', dash: '1,3',   directed: false, visible: true }],
]);

/**
 * Ensure a layer exists. If unknown, register it with defaults.
 * @param {string} layerId
 * @returns {LayerDef}
 */
export function ensureLayer(layerId) {
  let def = EDGE_LAYERS.get(layerId);
  if (!def) {
    def = {
      id: layerId,
      color: '#888888',
      dash: '',
      directed: false,
      visible: true,
    };
    EDGE_LAYERS.set(layerId, def);
  }
  return def;
}

/**
 * Get layer definition (or undefined).
 * @param {string} layerId
 * @returns {LayerDef|undefined}
 */
export function getLayer(layerId) {
  return EDGE_LAYERS.get(layerId);
}

/**
 * Set layer visibility.
 * @param {string} layerId
 * @param {boolean} visible
 */
export function setLayerVisible(layerId, visible) {
  const def = EDGE_LAYERS.get(layerId);
  if (def) def.visible = visible;
}

/**
 * Pull the current layer state from context lens.
 * Returns a Map of layerId -> { visible, opacity } reflecting
 * both the layer registry and the context's lensEdgeLayers.
 *
 * @param {import('../core/types.js').WorkingContext} context
 * @returns {Map<string, { visible: boolean, opacity: number }>}
 */
export function pullLayerState(context) {
  const state = new Map();
  for (const [id, def] of EDGE_LAYERS) {
    const inLens = context.lensEdgeLayers.has(id);
    const opacity = (context.weights.opacity && context.weights.opacity[id] != null)
      ? context.weights.opacity[id]
      : 1.0;
    state.set(id, {
      visible: def.visible && inLens,
      opacity,
    });
  }
  return state;
}

/**
 * Get all registered layer IDs.
 * @returns {string[]}
 */
export function layerIds() {
  return [...EDGE_LAYERS.keys()];
}

export { EDGE_LAYERS };
