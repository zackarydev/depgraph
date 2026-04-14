/**
 * Type A streaming: localStorage persistence.
 *
 * Every history append mirrors to localStorage. On reload, history
 * loads from localStorage first (if present), giving offline persistence
 * without any server.
 *
 * @module stream/local-persistence
 */

const STORAGE_KEY = 'depgraph:history';
const SNAPSHOT_KEY = 'depgraph:snapshot';

/**
 * Save full history CSV to localStorage.
 * @param {string} csv - full history as CSV text
 */
export function saveToLocal(csv) {
  try {
    localStorage.setItem(STORAGE_KEY, csv);
  } catch (e) {
    // localStorage full or unavailable — silent fail
    console.warn('depgraph: localStorage save failed', e.message);
  }
}

/**
 * Load history CSV from localStorage.
 * @returns {string|null} CSV text, or null if nothing stored
 */
export function loadFromLocal() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Clear stored history from localStorage.
 */
export function clearLocal() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // silent
  }
}

/**
 * Check if localStorage is available.
 * @returns {boolean}
 */
export function isLocalStorageAvailable() {
  try {
    const test = '__depgraph_test__';
    localStorage.setItem(test, '1');
    localStorage.removeItem(test);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire persistence to a bus: on every row-appended, save the full history.
 * Returns an unsub function.
 *
 * @param {Object} bus - event bus
 * @param {Object} history - history object
 * @param {Function} toCSV - history → CSV string function
 * @returns {Function} unsubscribe
 */
export function wirePersistence(bus, history, toCSV) {
  if (!isLocalStorageAvailable()) return () => {};

  return bus.on('row-appended', () => {
    saveToLocal(toCSV(history));
  });
}
