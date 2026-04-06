/**
 * Bootstrap: create core runtime, wire bus, start scheduler.
 *
 * Phase 1: no history, no rendering, no interaction.
 * Just proves the core loop ticks.
 *
 * @module main
 */

import { createBus } from './core/bus.js';
import { createState } from './core/state.js';
import { createScheduler } from './core/animation.js';
import { createContext } from './core/context.js';

/**
 * Initialize the depgraph runtime.
 * Returns the core objects for external access (testing, agent endpoints).
 */
export function init() {
  const bus = createBus();
  const state = createState();
  const context = createContext();
  const scheduler = createScheduler({
    render: () => {
      // Phase 5 will wire renderPositions() here.
      // For now, this is a no-op placeholder.
    },
  });

  // Log lifecycle events in dev
  bus.on('row-appended', ({ row }) => {
    console.log(`[bus] row-appended t=${row.t} ${row.type} ${row.op} ${row.id}`);
  });

  bus.on('context-changed', ({ context: ctx }) => {
    console.log(`[bus] context-changed → ${ctx.name}`);
  });

  // Start the scheduler (will tick at 60fps in the browser, no-op in Node)
  scheduler.start();

  return { bus, state, context, scheduler };
}

// Auto-init when loaded in the browser
if (typeof window !== 'undefined') {
  const runtime = init();
  window.__depgraph = runtime;
  console.log('depgraph runtime initialized', runtime);
}
