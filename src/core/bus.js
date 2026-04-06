/**
 * Typed event bus: pub/sub for all cross-module communication.
 *
 * Events:
 *   cursor-moved     { from: number, to: number }
 *   context-changed  { context: WorkingContext }
 *   row-appended     { row: HistoryRow }
 *   rebuild          {}
 *   selection-changed { selected: Set<string>, primary: string|null }
 *
 * @module core/bus
 */

/**
 * Create a new event bus.
 * @returns {{ on: Function, off: Function, emit: Function, once: Function, clear: Function }}
 */
export function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    const set = listeners.get(event);
    if (set) {
      set.delete(fn);
      if (set.size === 0) listeners.delete(event);
    }
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      fn(payload);
    }
  }

  function once(event, fn) {
    const wrapper = (payload) => {
      off(event, wrapper);
      fn(payload);
    };
    on(event, wrapper);
    return () => off(event, wrapper);
  }

  function clear() {
    listeners.clear();
  }

  return { on, off, emit, once, clear };
}
