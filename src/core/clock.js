/**
 * Hybrid Logical Clock (HLC): wall-clock + per-producer counter.
 *
 * Every moment carries an HLC coordinate (wallMs, producerId, counter).
 * Within a producer, coords are totally ordered. Across producers, two
 * coords with the same wallMs are *concurrent* — no ordering exists
 * unless one lists the other in its `causes`.
 *
 * This is the minimum machinery needed for the substrate to be honest
 * about concurrency. Today the UI is the only producer, so every coord
 * has producerId='ui' and counter advances monotonically. Tomorrow when
 * the watcher, runtime ticker, and agents become producers, the same
 * schema handles them without change.
 *
 * @module core/clock
 */

/**
 * @typedef {Object} HLCCoord
 * @property {number} wallMs
 * @property {string} producerId
 * @property {number} counter
 */

/**
 * Create an HLC for a single producer.
 * @param {string} producerId
 */
export function createHLC(producerId) {
  let lastWallMs = 0;
  let counter = 0;

  function next() {
    const now = Date.now();
    if (now > lastWallMs) {
      lastWallMs = now;
      counter = 0;
    } else {
      counter++;
    }
    return `${lastWallMs}:${producerId}:${counter}`;
  }

  function snapshot() {
    return { wallMs: lastWallMs, producerId, counter };
  }

  function observe(otherClock) {
    if (!otherClock) return;
    if (otherClock.wallMs > lastWallMs) {
      lastWallMs = otherClock.wallMs;
      counter = otherClock.counter + 1;
    } else if (otherClock.wallMs === lastWallMs && otherClock.counter >= counter) {
      counter = otherClock.counter + 1;
    }
  }

  return {
    next,
    snapshot,
    observe,
    get producerId() { return producerId; },
  };
}

/**
 * Compare two HLC coords.
 * Returns -1 (a before b), 1 (a after b), 0 (equal), or null (concurrent).
 * Concurrency occurs only when wallMs is equal and producerIds differ.
 *
 * @param {HLCCoord} a
 * @param {HLCCoord} b
 * @returns {-1|0|1|null}
 */
export function compareHLC(a, b) {
  if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
  if (a.producerId === b.producerId) {
    if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
    return 0;
  }
  return null;
}

/**
 * Parse an HLC string "wallMs:producerId:counter" back into a coord.
 * @param {string} s
 * @returns {HLCCoord}
 */
export function parseHLC(s) {
  const idx1 = s.indexOf(':');
  const idx2 = s.lastIndexOf(':');
  return {
    wallMs: Number(s.slice(0, idx1)),
    producerId: s.slice(idx1 + 1, idx2),
    counter: Number(s.slice(idx2 + 1)),
  };
}
