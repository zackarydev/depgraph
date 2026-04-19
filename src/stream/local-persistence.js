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
 *
 * On quota-exceeded, drops the oldest half of rows (keeping the header) and
 * retries once. If still over quota, stops persisting for this session — the
 * caller can re-enable by clearing. Without this, a long session dumps the
 * same OOM warning on every append.
 *
 * @param {string} csv - full history as CSV text
 * @returns {boolean} true if stored, false if dropped
 */
export function saveToLocal(csv) {
  try {
    localStorage.setItem(STORAGE_KEY, csv);
    return true;
  } catch (e) {
    // Quota exceeded: try once more with the oldest half trimmed.
    const trimmed = trimOldestHalf(csv);
    if (trimmed && trimmed.length < csv.length) {
      try {
        localStorage.setItem(STORAGE_KEY, trimmed);
        return true;
      } catch {
        /* fall through */
      }
    }
    console.warn('depgraph: localStorage over quota, dropping history persistence');
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    return false;
  }
}

function trimOldestHalf(csv) {
  const nl = csv.indexOf('\n');
  if (nl < 0) return null;
  const header = csv.slice(0, nl + 1);
  const body = csv.slice(nl + 1);
  const lines = body.split('\n');
  const keep = Math.floor(lines.length / 2);
  return header + lines.slice(-keep).join('\n');
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

  // Coalesce bursts (payload expansion emits many rows per user action) into
  // a single save per animation frame. Without this, one drag serializes the
  // full CSV dozens of times and blocks the main thread.
  let pending = false;
  let enabled = true;
  const schedule = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 16);

  const unsub = bus.on('row-appended', () => {
    if (!enabled || pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      if (!enabled) return;
      const ok = saveToLocal(toCSV(history));
      if (!ok) enabled = false;
    });
  });

  return unsub;
}
