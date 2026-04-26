/**
 * Runtime add demo: layers an executing call onto the static fractal of
 * `function add(X, Y) { Z = X + Y; return Z }`.
 *
 * The structural scaffold comes from demo-add-fractal — every L0/L1/L2/L3
 * node is reused unchanged. On top, this module adds a `call_site` node and
 * a tiny rule engine that emits runtime value-nodes for `add(2, 3)`:
 *
 *   step 1 — "bind"     : rt_v2 (label "2") and rt_v3 (label "3") appear at
 *                         the call site and are pulled into the parameter
 *                         slots tok_X / tok_Y by high-weight runtime-flow
 *                         edges.
 *   step 2 — "compute"  : rt_v5 (label "5") is emitted at tok_plus, the body
 *                         operator, and is pulled back toward call_site.
 *   step 3 — "cleanup"  : the runtime value-nodes are removed and the cycle
 *                         returns to idle.
 *
 * Structural nodes get mass=1000 (near-rigid). Runtime nodes get mass=1, so
 * the descent step actually moves them while the scaffold stays put.
 *
 * See RUNTIME_RULES.md for the conceptual model this is the smallest
 * possible demo of.
 *
 * @module data/demo-runtime-add
 */

import { generateAddFractalHistory, ADD_FRACTAL_POSITIONS } from './demo-add-fractal.js';
import { setMass, setSticky, updatePosition } from '../layout/positions.js';
import { ensureLayer } from '../edges/layers.js';

// ─── Positions ───────────────────────────────────────────────

const CALL_SITE_POS = { x: 220, y: -50 };

export const RUNTIME_ADD_POSITIONS = {
  ...ADD_FRACTAL_POSITIONS,
  call_site: CALL_SITE_POS,
};

// Runtime value-nodes spawn at call_site and are pulled to these targets.
const PARAM_SLOTS = {
  rt_v2: 'tok_X',
  rt_v3: 'tok_Y',
};

// The body operator that "produces" the result.
const BODY_OP = 'tok_plus';

// Edge layers minted for runtime motion. `runtime-bind` pulls args into
// param slots; `runtime-return` pulls the result back to the call site.
const BIND_LAYER = 'runtime-bind';
const RETURN_LAYER = 'runtime-return';

const STRUCTURAL_MASS = 1000;
const RUNTIME_MASS = 1;

// ─── History ─────────────────────────────────────────────────

/**
 * Hand-authored history: the fractal of `add` plus a call_site node.
 * The call_site is structural (high mass) and lives on its own to the right
 * of the function block. Runtime value-nodes are NOT in this seed — they
 * are emitted live by createRuntimeEngine().
 *
 * @returns {import('../core/types.js').HistoryRow[]}
 */
export function generateRuntimeAddHistory() {
  const rows = generateAddFractalHistory();
  let t = rows.length;

  rows.push({
    t: t++, type: 'NODE', op: 'add',
    id: 'call_site', kind: 'cluster', label: 'add(2, 3)', weight: 6,
  });
  rows.push({
    t: t++, type: 'EDGE', op: 'add',
    id: 'call_site→add@calls',
    source: 'call_site', target: 'add', layer: 'calls', weight: 1,
  });

  return rows;
}

// ─── Rule engine ─────────────────────────────────────────────

/**
 * @typedef {'idle'|'bound'|'returned'} RuntimePhase
 */

/**
 * Build the runtime engine for the add demo. Holds a tiny state machine:
 * each call to step() advances one phase and emits the rows for that phase.
 *
 * @param {Object} runtime - the depgraph runtime returned by init()
 * @param {Object} [opts]
 * @param {number} [opts.tickMs=2500] - auto-step interval when playing
 * @returns {{
 *   step: () => RuntimePhase,
 *   play: () => void,
 *   pause: () => void,
 *   reset: () => void,
 *   isPlaying: () => boolean,
 *   currentPhase: () => RuntimePhase,
 * }}
 */
export function createRuntimeEngine(runtime, opts = {}) {
  const tickMs = opts.tickMs || 2500;
  const { posMap, appendRow, state, context } = runtime;

  // Make custom edge layers visible + give them a strong physics weight so
  // their springs actually yank runtime nodes through the scaffold.
  ensureLayer(BIND_LAYER);
  ensureLayer(RETURN_LAYER);
  context.lensEdgeLayers.add(BIND_LAYER);
  context.lensEdgeLayers.add(RETURN_LAYER);
  context.weights.physics[BIND_LAYER] = 2.0;
  context.weights.physics[RETURN_LAYER] = 2.0;
  context.weights.affinity[BIND_LAYER] = 0;
  context.weights.affinity[RETURN_LAYER] = 0;
  context.weights.opacity[BIND_LAYER] = 1.0;
  context.weights.opacity[RETURN_LAYER] = 1.0;

  for (const id of Object.keys(RUNTIME_ADD_POSITIONS)) {
    setMass(posMap, id, STRUCTURAL_MASS);
    setSticky(posMap, id, true);
  }

  /** @type {RuntimePhase} */
  let phase = 'idle';
  let playing = false;
  let timer = null;

  function emitNode(id, label, kind = 'runtime', weight = 3) {
    appendRow({ type: 'NODE', op: 'add', id, kind, label, weight });
  }
  function emitEdge(id, source, target, layer, weight = 1) {
    appendRow({ type: 'EDGE', op: 'add', id, source, target, layer, weight });
  }
  function removeNode(id) {
    if (state.nodes.has(id)) appendRow({ type: 'NODE', op: 'remove', id });
  }
  function removeEdge(id) {
    if (state.edges.has(id)) appendRow({ type: 'EDGE', op: 'remove', id });
  }

  // After spawning a runtime node, drop it on top of call_site so the spring
  // to its target slot has a visible distance to traverse. seedNewNodePosition
  // would otherwise place it at the centroid of its connected neighbors —
  // which is the target slot itself, leaving no motion.
  function spawnAtCallSite(id) {
    const cs = posMap.positions.get('call_site');
    if (!cs) return;
    updatePosition(posMap, id, cs.x + (Math.random() - 0.5) * 8, cs.y + (Math.random() - 0.5) * 8);
    setMass(posMap, id, RUNTIME_MASS);
    setSticky(posMap, id, false);
  }

  function spawnAt(id, refId) {
    const ref = posMap.positions.get(refId);
    if (!ref) return;
    updatePosition(posMap, id, ref.x + (Math.random() - 0.5) * 8, ref.y + (Math.random() - 0.5) * 8);
    setMass(posMap, id, RUNTIME_MASS);
    setSticky(posMap, id, false);
  }

  function bindArgs() {
    for (const [rtId, slot] of Object.entries(PARAM_SLOTS)) {
      const value = rtId === 'rt_v2' ? '2' : '3';
      emitNode(rtId, value, 'runtime', 4);
      // Edge from the runtime value to its bound parameter slot. Spring rest
      // is small (slot pulls runtime in close) and weight is high so the
      // pull dominates.
      emitEdge(`${rtId}→${slot}@${BIND_LAYER}`, rtId, slot, BIND_LAYER, 1);
      spawnAtCallSite(rtId);
    }
  }

  function computeAndReturn() {
    emitNode('rt_v5', '5', 'runtime', 5);
    // Two edges: tethered at the body operator, pulled back to call_site.
    // The combined spring drags rt_v5 along the return path.
    emitEdge(`rt_v5→${BODY_OP}@${BIND_LAYER}`, 'rt_v5', BODY_OP, BIND_LAYER, 1);
    emitEdge(`rt_v5→call_site@${RETURN_LAYER}`, 'rt_v5', 'call_site', RETURN_LAYER, 2);
    spawnAt('rt_v5', BODY_OP);
  }

  function cleanup() {
    for (const rtId of Object.keys(PARAM_SLOTS)) {
      const slot = PARAM_SLOTS[rtId];
      removeEdge(`${rtId}→${slot}@${BIND_LAYER}`);
      removeNode(rtId);
    }
    removeEdge(`rt_v5→${BODY_OP}@${BIND_LAYER}`);
    removeEdge(`rt_v5→call_site@${RETURN_LAYER}`);
    removeNode('rt_v5');
  }

  function step() {
    if (phase === 'idle') {
      bindArgs();
      phase = 'bound';
    } else if (phase === 'bound') {
      computeAndReturn();
      phase = 'returned';
    } else {
      cleanup();
      phase = 'idle';
    }
    return phase;
  }

  function play() {
    if (playing) return;
    playing = true;
    timer = setInterval(step, tickMs);
  }
  function pause() {
    playing = false;
    if (timer) { clearInterval(timer); timer = null; }
  }
  function reset() {
    pause();
    cleanup();
    phase = 'idle';
  }

  return {
    step,
    play,
    pause,
    reset,
    isPlaying: () => playing,
    currentPhase: () => phase,
  };
}

// ─── UI panel ────────────────────────────────────────────────

/**
 * Mount a small floating control panel (Play / Step / Reset) in the bottom-
 * right corner. Self-contained: builds its own DOM, no dependencies on the
 * existing toolbar.
 *
 * @param {ReturnType<typeof createRuntimeEngine>} engine
 */
export function attachRuntimeUI(engine) {
  if (typeof document === 'undefined') return;

  const root = document.createElement('div');
  root.id = 'runtime-add-controls';
  root.style.cssText = `
    position: fixed; bottom: 16px; right: 16px; z-index: 20;
    background: #111118ee; border: 1px solid #2a2a35; border-radius: 6px;
    padding: 10px 14px; font-size: 11px;
    display: flex; align-items: center; gap: 8px;
    font-family: 'SF Mono', 'Fira Code', ui-monospace, Menlo, monospace;
    color: #ccc;
  `;

  const label = document.createElement('span');
  label.style.cssText = 'color: #888; min-width: 90px;';
  label.textContent = 'phase: idle';

  const playBtn = document.createElement('button');
  playBtn.textContent = 'play';
  const stepBtn = document.createElement('button');
  stepBtn.textContent = 'step';
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'reset';

  for (const b of [playBtn, stepBtn, resetBtn]) {
    b.style.cssText = `
      background: #1a1a25; color: #ccc;
      border: 1px solid #333; border-radius: 4px;
      padding: 3px 10px; font-family: inherit; font-size: 11px; cursor: pointer;
    `;
  }

  function refresh() {
    label.textContent = `phase: ${engine.currentPhase()}`;
    playBtn.textContent = engine.isPlaying() ? 'pause' : 'play';
  }

  playBtn.addEventListener('click', () => {
    if (engine.isPlaying()) engine.pause();
    else engine.play();
    refresh();
  });
  stepBtn.addEventListener('click', () => { engine.step(); refresh(); });
  resetBtn.addEventListener('click', () => { engine.reset(); refresh(); });

  root.append(label, playBtn, stepBtn, resetBtn);
  document.body.appendChild(root);

  // Keep the label in sync when play-mode auto-steps.
  setInterval(refresh, 200);
}
