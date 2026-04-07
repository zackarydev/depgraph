/**
 * Single selectedNode + selectedNodes Set, one code path.
 *
 * Pure state management for selection. Does not touch the DOM.
 * Emits 'selection-changed' on the bus when selection mutates.
 *
 * SPEC §10: click = select, shift+click = pin (multi-select + lock),
 * Escape or click-empty = deselect all.
 *
 * @module interact/select
 */

/**
 * @typedef {Object} SelectionState
 * @property {string|null} primary - the most recently clicked node id
 * @property {Set<string>} selected - all currently selected node ids
 */

/**
 * Create an empty selection state.
 * @returns {SelectionState}
 */
export function createSelection() {
  return { primary: null, selected: new Set() };
}

/**
 * Select a single node (replaces any existing selection).
 * @param {SelectionState} sel
 * @param {string} nodeId
 * @returns {SelectionState}
 */
export function selectNode(sel, nodeId) {
  return { primary: nodeId, selected: new Set([nodeId]) };
}

/**
 * Toggle a node in multi-select mode (shift+click).
 * If already selected, removes it. Otherwise adds it and makes it primary.
 *
 * @param {SelectionState} sel
 * @param {string} nodeId
 * @returns {SelectionState}
 */
export function toggleSelection(sel, nodeId) {
  const next = new Set(sel.selected);
  if (next.has(nodeId)) {
    next.delete(nodeId);
    return {
      primary: next.size > 0 ? [...next][next.size - 1] : null,
      selected: next,
    };
  }
  next.add(nodeId);
  return { primary: nodeId, selected: next };
}

/**
 * Clear all selection.
 * @param {SelectionState} [_sel]
 * @returns {SelectionState}
 */
export function clearSelection(_sel) {
  return createSelection();
}

/**
 * Check if a node is selected.
 * @param {SelectionState} sel
 * @param {string} nodeId
 * @returns {boolean}
 */
export function isSelected(sel, nodeId) {
  return sel.selected.has(nodeId);
}

/**
 * Get count of selected nodes.
 * @param {SelectionState} sel
 * @returns {number}
 */
export function selectionCount(sel) {
  return sel.selected.size;
}

/**
 * Select multiple nodes at once (e.g. re-select a user cluster from legend).
 * @param {Iterable<string>} nodeIds
 * @returns {SelectionState}
 */
export function selectMany(nodeIds) {
  const set = new Set(nodeIds);
  const arr = [...set];
  return {
    primary: arr.length > 0 ? arr[arr.length - 1] : null,
    selected: set,
  };
}
