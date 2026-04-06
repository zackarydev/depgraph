/**
 * ONE requestAnimationFrame scheduler; modules register tick functions.
 *
 * All interaction loops (attractor, gather, trace, etc.) register their
 * per-frame update here. The scheduler calls all active updaters, then
 * calls renderPositions() exactly ONCE per frame. No independent RAF chains.
 *
 * @module core/animation
 */

/**
 * @callback TickFn
 * @param {number} dt - milliseconds since last frame
 * @param {number} now - current timestamp (from rAF)
 */

/**
 * @callback RenderFn
 * Called once per frame after all ticks.
 */

/**
 * Create the animation scheduler.
 *
 * @param {Object} [options]
 * @param {RenderFn} [options.render] - the single renderPositions() call
 * @param {Function} [options.raf] - injectable rAF for testing (defaults to requestAnimationFrame)
 * @param {Function} [options.caf] - injectable cancelAnimationFrame for testing
 * @returns {{ register, unregister, start, stop, isRunning, setRender, tickCount }}
 */
export function createScheduler(options = {}) {
  let render = options.render || null;
  const noopRaf = (cb) => { return setTimeout(cb, 0); };
  const noopCaf = (id) => { clearTimeout(id); };
  const raf = options.raf || (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : noopRaf);
  const caf = options.caf || (typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame : noopCaf);

  /** @type {Map<string, TickFn>} */
  const ticks = new Map();

  let rafId = null;
  let lastTime = 0;
  let _tickCount = 0;
  let running = false;

  function frame(now) {
    if (!running) return;
    const dt = lastTime ? now - lastTime : 16;
    lastTime = now;
    _tickCount++;

    // call all registered tick functions
    for (const [, fn] of ticks) {
      fn(dt, now);
    }

    // single render call per frame
    if (render) render();

    rafId = raf(frame);
  }

  function register(name, fn) {
    ticks.set(name, fn);
  }

  function unregister(name) {
    ticks.delete(name);
  }

  function start() {
    if (running) return;
    running = true;
    lastTime = 0;
    rafId = raf(frame);
  }

  function stop() {
    running = false;
    if (rafId != null && caf) {
      caf(rafId);
    }
    rafId = null;
    lastTime = 0;
  }

  function isRunning() {
    return running;
  }

  function setRender(fn) {
    render = fn;
  }

  return {
    register,
    unregister,
    start,
    stop,
    isRunning,
    setRender,
    get tickCount() { return _tickCount; },
    get tickNames() { return [...ticks.keys()]; },
  };
}
