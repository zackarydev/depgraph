/**
 * Phase 6.5: full boot pipeline.
 *
 * Loads history (demo or CSV), derives clusters, places nodes via
 * gradient descent, renders via fractal engine, wires interactions.
 *
 * @module main
 */

import { createBus } from './core/bus.js';
import { createState } from './core/state.js';
import { createScheduler } from './core/animation.js';
import { createContext } from './core/context.js';
import { createHistory, load as loadHistory, append as historyAppend, effectiveRows } from './data/history.js';
import { writeCSV } from './data/csv.js';
import { buildFromHistory, applyRowToGraph, rederive } from './data/graph-builder.js';
import { deriveAll } from './data/derive.js';
import { initialPlace } from './layout/placement.js';
import { warmRestart } from './layout/warm-restart.js';
import { createPositionMap } from './layout/positions.js';
import { computeRenderPlan } from './render/fractal.js';
import { initSVG } from './render/svg.js';
import { renderNodes } from './render/nodes.js';
import { renderEdges } from './render/edges.js';
import { renderLabels, renderClusterLabels } from './render/labels.js';
import { renderHulls } from './render/hulls.js';
import { renderPositions, createRenderFn } from './render/positions.js';
import { generateDemoHistory } from './data/demo-history.js';
import { createSelection, selectNode, toggleSelection, clearSelection } from './interact/select.js';
import { startDrag, onDrag, endDrag } from './interact/drag.js';
import { createKeyState, keyDown, keyUp } from './interact/keyboard.js';
import { startTrace, flashTrace, updateTrace, revealedNodes, releaseTrace, holdTrace, changeDirection } from './interact/trace.js';
import { startGather, startStrangerGather, updateGather, stopGather } from './interact/gather.js';
import { startAttractor, updateAttractor, stopAttractor } from './interact/attractor.js';
import { startReset, updateReset, stopReset } from './interact/reset.js';
import { startTimeTravel, updateTimeTravel, stopTimeTravel, stepOnce, switchBranchByDirection } from './interact/time-travel.js';
import { createArrangementStack, pushArrangement, startTravel as startArrangementTravel, updateTravel as updateArrangementTravel, stopTravel as stopArrangementTravel } from './interact/arrangements.js';
import { getLayer } from './edges/layers.js';
import { loadFromLocal, wirePersistence, isLocalStorageAvailable } from './stream/local-persistence.js';
import { tryConnectSSE } from './stream/sse.js';
import { toCSV } from './data/history.js';
import { startCinematic, stopCinematic, isCinematicActive } from './stream/cinematic.js';

/**
 * Initialize the depgraph runtime.
 * @param {Object} [opts]
 * @param {string} [opts.csv] - CSV history string to load
 * @param {Element} [opts.container] - DOM element for SVG (default: #viewport)
 * @param {boolean} [opts.localStorage=true] - persist to localStorage
 * @param {string} [opts.sseUrl] - SSE endpoint URL for live updates
 * @param {boolean} [opts.cinematic=false] - enable cinematic mode for live nodes
 * @returns {Object} runtime handle
 */
export function init(opts = {}) {
  const bus = createBus();
  const context = createContext();
  const scheduler = createScheduler();

  // --- History ---
  // Priority: explicit CSV > localStorage > demo
  let history;
  if (opts.csv) {
    history = loadHistory(opts.csv);
  } else if (typeof window !== 'undefined' && opts.localStorage !== false) {
    const stored = loadFromLocal();
    if (stored) {
      history = loadHistory(stored);
    } else {
      history = createHistory();
      const rows = generateDemoHistory();
      for (const row of rows) {
        historyAppend(history, row);
      }
    }
  } else {
    // Node.js / no localStorage
    history = createHistory();
    const rows = generateDemoHistory();
    for (const row of rows) {
      historyAppend(history, row);
    }
  }

  // --- Graph (state + derivation) ---
  const eff = effectiveRows(history);
  const graph = buildFromHistory(eff, context.weights.affinity);

  // --- Layout ---
  const { posMap } = initialPlace(graph.state.nodes, graph.state.edges, context.weights.physics);

  // --- SVG (browser only) ---
  let svgCtx = null;
  let renderState = null;

  if (typeof document !== 'undefined') {
    const container = opts.container || document.getElementById('viewport');
    // Remove existing SVG if present (index.html has a static one)
    const existingSvg = container && container.querySelector('svg');
    if (existingSvg) existingSvg.remove();

    if (container) {
      svgCtx = initSVG(container);
    }
  }

  // --- Selection & interaction state ---
  let selection = createSelection();
  let keyState = createKeyState();
  let dragState = null;
  let traceState = null;
  let gatherState = null;
  let attractorState = null;
  let resetState = null;
  let timeTravelState = null;
  let arrangementTravelState = null;
  const arrangements = createArrangementStack();
  let currentZoom = 1;

  // --- Render state for the pump ---
  // Persistent DOM keyed by id so fullRender() can diff rather than
  // tear down every frame. The Z-key complaint ("removed one at a time",
  // "lerp back to original locations") was caused by blowing away the
  // entire layer on every step — now elements persist and only the
  // genuinely changed ones are added or removed.
  if (svgCtx) {
    renderState = {
      posMap,
      svgCtx,
      nodeElements: new Map(),   // id -> <circle>
      labelElements: new Map(),  // id -> <text>
      edgeElements: new Map(),   // id -> <line>
      // id -> { grad: <linearGradient>, stops: [<stop>*5], color, source, target }
      // Proximity gradients: solid at endpoints, fading mid when far.
      gradientElements: new Map(),
      // Lerp display positions toward posMap each frame during smooth modes.
      displayPositions: new Map(), // id -> {x, y}
      smoothMotion: false,
    };
  }

  // --- HUD: populated lazily if the page has #hud-bar / #arr-nav elements ---
  // Defined up here so every handler that calls it is defined below. The
  // real body reads from graph/arrangements; see #hud-bar in index.html.
  function updateHud() {
    if (typeof document === 'undefined') return;
    const hud = document.getElementById('hud-bar');
    if (hud) {
      const nNodes = graph.state.nodes.size;
      const nEdges = graph.state.edges.size;
      const cursor = history.cursor;
      const arrIdx = arrangements.cursor + 1;
      const arrTotal = arrangements.stack.length;
      hud.querySelector('[data-hud=nodes]').textContent = String(nNodes);
      hud.querySelector('[data-hud=edges]').textContent = String(nEdges);
      hud.querySelector('[data-hud=cursor]').textContent = `t${cursor}`;
      hud.querySelector('[data-hud=arr]').textContent = arrTotal
        ? `${arrIdx} / ${arrTotal}`
        : '0 / 0';
    }
    const arrNav = document.getElementById('arr-nav');
    if (arrNav) {
      const canBack = arrangements.cursor > 0;
      const canFwd = arrangements.cursor < arrangements.stack.length - 1;
      arrNav.classList.toggle('visible', arrangements.stack.length > 0);
      const back = arrNav.querySelector('[data-arr=back]');
      const fwd = arrNav.querySelector('[data-arr=fwd]');
      const label = arrNav.querySelector('[data-arr=label]');
      if (back) back.disabled = !canBack;
      if (fwd) fwd.disabled = !canFwd;
      if (label) label.textContent = arrangements.stack.length
        ? `${arrangements.cursor + 1} / ${arrangements.stack.length}`
        : '—';
    }
  }

  // --- Full re-render from render plan (diff-based) ---
  function fullRender() {
    if (!svgCtx) return;

    const plan = computeRenderPlan({
      nodes: graph.state.nodes,
      edges: graph.state.edges,
      clusters: graph.derivation.clusters,
      posMap,
      context,
      zoom: currentZoom,
    });

    // Hulls & cluster labels: small counts, no stable id — rebuild each time.
    const gHulls = svgCtx.layers.gHulls;
    while (gHulls.firstChild) gHulls.removeChild(gHulls.firstChild);
    for (const h of plan.hulls) {
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', h.hull.map(p => p.join(',')).join(' '));
      poly.setAttribute('fill', `hsla(${h.depth * 60 + 200}, 50%, 30%, 0.15)`);
      poly.setAttribute('stroke', `hsla(${h.depth * 60 + 200}, 60%, 50%, 0.4)`);
      poly.setAttribute('stroke-width', '1.5');
      gHulls.appendChild(poly);
    }

    const gClusterLabels = svgCtx.layers.gClusterLabels;
    while (gClusterLabels.firstChild) gClusterLabels.removeChild(gClusterLabels.firstChild);
    for (const cl of plan.clusterLabels) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', cl.x);
      text.setAttribute('y', cl.y);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '13');
      text.setAttribute('fill', '#e8e');
      text.setAttribute('font-weight', 'bold');
      text.textContent = cl.label;
      gClusterLabels.appendChild(text);
    }

    // --- Diff edges ---
    const gLinks = svgCtx.layers.gLinks;
    const defs = svgCtx.defs;
    const edgeElements = renderState.edgeElements;
    const gradientElements = renderState.gradientElements;
    const seenEdges = new Set();
    for (const edge of plan.edges) {
      const ps = posMap.positions.get(edge.source);
      const pt = posMap.positions.get(edge.target);
      if (!ps || !pt) continue;
      seenEdges.add(edge.id);
      const layerDef = getLayer(edge.layer);
      const color = edge.isMeta ? '#ffee66' : (layerDef ? layerDef.color : '#4a9eff');

      // Proximity gradient: 5 stops, solid at ends, fading mid by distance.
      let grad = gradientElements.get(edge.id);
      if (!grad) {
        const gradEl = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        gradEl.setAttribute('id', `edge-grad-${cssId(edge.id)}`);
        gradEl.setAttribute('gradientUnits', 'userSpaceOnUse');
        const stops = [];
        for (const offset of ['0%', '25%', '50%', '75%', '100%']) {
          const s = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
          s.setAttribute('offset', offset);
          gradEl.appendChild(s);
          stops.push(s);
        }
        defs.appendChild(gradEl);
        grad = { grad: gradEl, stops, color, source: edge.source, target: edge.target };
        gradientElements.set(edge.id, grad);
      }
      grad.color = color;
      grad.source = edge.source;
      grad.target = edge.target;
      for (const s of grad.stops) s.setAttribute('stop-color', color);
      // Endpoints + mid-opacity get updated by the render pump each frame;
      // still do a first-frame pass here so the initial paint is correct.
      updateGradientStops(grad, ps.x, ps.y, pt.x, pt.y);

      let line = edgeElements.get(edge.id);
      if (!line) {
        line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('data-id', edge.id);
        gLinks.appendChild(line);
        edgeElements.set(edge.id, line);
      }
      line.setAttribute('data-source', edge.source);
      line.setAttribute('data-target', edge.target);
      line.setAttribute('x1', ps.x);
      line.setAttribute('y1', ps.y);
      line.setAttribute('x2', pt.x);
      line.setAttribute('y2', pt.y);
      line.setAttribute('stroke', `url(#${grad.grad.getAttribute('id')})`);
      line.setAttribute('stroke-width', edge.isMeta ? '2' : String(Math.max(0.5, Math.min(3, edge.weight))));
      line.setAttribute('stroke-opacity', edge.isMeta ? '0.75' : '0.85');
      if (edge.isMeta) line.setAttribute('stroke-dasharray', '6,3');
      else if (layerDef && layerDef.dash) line.setAttribute('stroke-dasharray', layerDef.dash);
    }
    for (const [id, el] of edgeElements) {
      if (!seenEdges.has(id)) {
        el.remove();
        edgeElements.delete(id);
        const g = gradientElements.get(id);
        if (g) { g.grad.remove(); gradientElements.delete(id); }
      }
    }

    // --- Diff nodes ---
    const gNodes = svgCtx.layers.gNodes;
    const nodeElements = renderState.nodeElements;
    const seenNodes = new Set();
    for (const node of plan.nodes) {
      const ps = posMap.positions.get(node.id);
      if (!ps) continue;
      seenNodes.add(node.id);
      const r = node.isCluster ? 8 + node.importance : 4 + (node.importance || 1) * 2;
      let circle = nodeElements.get(node.id);
      if (!circle) {
        circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('data-id', node.id);
        gNodes.appendChild(circle);
        nodeElements.set(node.id, circle);
      }
      circle.setAttribute('cx', ps.x);
      circle.setAttribute('cy', ps.y);
      circle.setAttribute('r', Math.min(r, 20));
      circle.setAttribute('fill', nodeColor(node.kind));
      circle.setAttribute('stroke', node.isCluster ? '#c9a' : '#fff');
      circle.setAttribute('stroke-width', node.isCluster ? '2' : '1');
      circle.setAttribute('stroke-opacity', '0.7');
      circle.setAttribute('class', `node node-${node.kind}`);
    }
    for (const [id, el] of nodeElements) {
      if (!seenNodes.has(id)) {
        el.remove();
        nodeElements.delete(id);
        renderState.displayPositions.delete(id);
      }
    }

    // --- Diff labels ---
    const gLabels = svgCtx.layers.gLabels;
    const labelElements = renderState.labelElements;
    const seenLabels = new Set();
    for (const node of plan.nodes) {
      const ps = posMap.positions.get(node.id);
      if (!ps) continue;
      seenLabels.add(node.id);
      let text = labelElements.get(node.id);
      if (!text) {
        text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('text-anchor', 'middle');
        gLabels.appendChild(text);
        labelElements.set(node.id, text);
      }
      text.setAttribute('x', ps.x);
      text.setAttribute('y', ps.y - 12);
      text.setAttribute('font-size', node.isCluster ? '11' : '9');
      text.setAttribute('fill', node.isCluster ? '#c9a' : '#aaa');
      text.setAttribute('font-weight', node.isCluster ? 'bold' : 'normal');
      if (text.textContent !== node.label) text.textContent = node.label;
    }
    for (const [id, el] of labelElements) {
      if (!seenLabels.has(id)) {
        el.remove();
        labelElements.delete(id);
      }
    }

    // Render selection rings (they depend on current selection, not plan)
    renderSelectionRings();
  }

  // --- Selection ring rendering ---
  function renderSelectionRings() {
    if (!svgCtx) return;
    const existing = svgCtx.layers.gNodes.querySelectorAll('.sel-ring');
    existing.forEach(r => r.remove());
    for (const id of selection.selected) {
      const ps = posMap.positions.get(id);
      if (!ps) continue;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', ps.x);
      circle.setAttribute('cy', ps.y);
      circle.setAttribute('r', '14');
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', '#0ff');
      circle.setAttribute('stroke-width', '2');
      circle.setAttribute('class', 'sel-ring');
      svgCtx.layers.gNodes.appendChild(circle);
    }
  }

  // --- Trace overlay rendering ---
  function renderTraceOverlay() {
    if (!svgCtx || !traceState || !traceState.active) {
      clearTraceOverlay();
      return;
    }
    clearTraceOverlay();
    const revealed = revealedNodes(traceState);
    for (const id of revealed) {
      const ps = posMap.positions.get(id);
      if (!ps) continue;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', ps.x);
      circle.setAttribute('cy', ps.y);
      circle.setAttribute('r', '10');
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', '#0f0');
      circle.setAttribute('stroke-width', '2');
      circle.setAttribute('stroke-opacity', '0.8');
      circle.setAttribute('class', 'trace-ring');
      svgCtx.layers.gNodes.appendChild(circle);
    }
  }

  function clearTraceOverlay() {
    if (!svgCtx) return;
    const rings = svgCtx.layers.gNodes.querySelectorAll('.trace-ring');
    rings.forEach(r => r.remove());
  }

  // --- Append row to history + update graph ---
  function appendRow(row) {
    const fullRow = historyAppend(history, row);
    applyRowToGraph(graph, fullRow, context.weights.affinity);

    // Place new nodes
    if (row.type === 'NODE' && row.op === 'add') {
      warmRestart(posMap, graph.state.nodes, graph.state.edges, context.weights.physics);
    }

    bus.emit('row-appended', { row: fullRow });
    return fullRow;
  }

  // --- Bus wiring ---
  bus.on('row-appended', () => {
    updateHud();
    fullRender();
  });

  bus.on('context-changed', ({ context: ctx }) => {
    rederive(graph, ctx.weights.affinity);
    fullRender();
  });

  bus.on('selection-changed', () => {
    renderSelectionRings();
  });

  // --- Convert screen coords to world coords ---
  function screenToWorld(screenX, screenY) {
    const t = svgCtx ? svgCtx.transform : { x: 0, y: 0, k: 1 };
    return {
      x: (screenX - t.x) / t.k,
      y: (screenY - t.y) / t.k,
    };
  }

  // --- Find node at world position ---
  function hitTest(worldX, worldY) {
    let closest = null;
    let closestDist = Infinity;
    for (const [id, ps] of posMap.positions) {
      const dx = ps.x - worldX;
      const dy = ps.y - worldY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 20 && d < closestDist) {
        closest = id;
        closestDist = d;
      }
    }
    return closest;
  }

  // --- Wire DOM events (6.5b) ---
  if (svgCtx) {
    const svg = svgCtx.svg;

    // Mouse state — declared early so the d3.zoom filter can reference it.
    let mouseDownTarget = null;
    let mouseDownPos = null;
    let isDragging = false;

    // Track zoom changes for fractal LOD
    if (typeof d3 !== 'undefined' && d3.zoom) {
      const zoom = d3.zoom()
        .scaleExtent([0.1, 12])
        // Skip zoom/pan when the gesture starts on a node or cluster label —
        // those clicks belong to selection / drag, not to panning.
        .filter((event) => {
          if (event.type === 'mousedown' && event.button !== 0) return false;
          const rect = svg.getBoundingClientRect();
          const sx = event.clientX - rect.left;
          const sy = event.clientY - rect.top;
          const world = screenToWorld(sx, sy);
          return hitTest(world.x, world.y) == null;
        })
        .on('zoom', (event) => {
          const t = event.transform;
          svgCtx.root.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
          svgCtx.transform = { x: t.x, y: t.y, k: t.k };
          const prevZoom = currentZoom;
          currentZoom = t.k;
          if (Math.abs(currentZoom - prevZoom) / prevZoom > 0.1) {
            fullRender();
          }
        });
      d3.select(svg).call(zoom);
    }

    // Capture-phase mousedown so our handler runs before d3-zoom's
    // stopImmediatePropagation can swallow node clicks.
    svg.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = svg.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      const nodeId = hitTest(world.x, world.y);

      mouseDownTarget = nodeId;
      mouseDownPos = { sx, sy, wx: world.x, wy: world.y };
      isDragging = false;

      if (nodeId) {
        dragState = startDrag(nodeId, posMap, selection, e.shiftKey);
      }
    }, true);

    // Window-level move/up so releases off-svg still finalize the gesture.
    window.addEventListener('mousemove', (e) => {
      if (!mouseDownPos) return;
      const rect = svg.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy);

      const dx = sx - mouseDownPos.sx;
      const dy = sy - mouseDownPos.sy;
      if (Math.sqrt(dx * dx + dy * dy) > 3) {
        isDragging = true;
      }

      if (dragState && isDragging) {
        onDrag(dragState, world.x, world.y, posMap);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!mouseDownPos) return;
      if (dragState && isDragging) {
        const rows = endDrag(dragState, posMap);
        for (const row of rows) {
          appendRow(row);
        }
        if (rows.length > 0) {
          pushArrangement(arrangements, 'drag', posMap);
          updateHud();
        }
      } else if (mouseDownTarget && !isDragging) {
        if (e.shiftKey) {
          selection = toggleSelection(selection, mouseDownTarget);
        } else {
          selection = selectNode(selection, mouseDownTarget);
        }
        bus.emit('selection-changed', { selected: selection.selected, primary: selection.primary });
      } else if (!mouseDownTarget && !isDragging) {
        selection = clearSelection();
        bus.emit('selection-changed', { selected: selection.selected, primary: selection.primary });
      }

      mouseDownPos = null;
      mouseDownTarget = null;
      isDragging = false;
      dragState = null;
    });

    // Keyboard events
    document.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
      const action = keyDown(keyState, key, mods);
      if (!action) return;

      switch (action.action) {
        case 'gather-start':
          if (selection.selected.size >= 2) {
            gatherState = startGather(selection, posMap);
            if (gatherState) {
              scheduler.register('gather', (dt) => {
                updateGather(gatherState, dt, posMap);
              });
            }
          } else if (selection.primary) {
            gatherState = startStrangerGather(selection.primary, graph.state.edges, selection, posMap);
            if (gatherState) {
              scheduler.register('gather', (dt) => {
                updateGather(gatherState, dt, posMap);
              });
            }
          }
          break;

        case 'gather-stop':
          if (gatherState) {
            stopGather(gatherState);
            scheduler.unregister('gather');
            gatherState = null;
            pushArrangement(arrangements, 'gather', posMap);
            updateHud();
            fullRender();
          }
          break;

        case 'trace-start':
          if (selection.primary) {
            traceState = startTrace(selection.primary, graph.state.edges, context);
            scheduler.register('trace', (dt) => {
              if (traceState && updateTrace(traceState, dt)) {
                renderTraceOverlay();
              }
            });
            renderTraceOverlay();
          }
          break;

        case 'trace-release':
          if (traceState && !traceState.held) {
            releaseTrace(traceState);
            scheduler.unregister('trace');
            clearTraceOverlay();
            traceState = null;
          }
          break;

        case 'trace-hold':
          if (traceState) holdTrace(traceState);
          break;

        case 'trace-direction':
          if (traceState) {
            traceState = changeDirection(traceState, action.direction, graph.state.edges, context);
          }
          break;

        case 'reset-start':
          resetState = startReset(action.ctrl);
          if (renderState) renderState.smoothMotion = true;
          scheduler.register('reset', (dt) => {
            if (resetState) updateReset(resetState, dt, posMap, graph.state.edges, context.weights.physics);
          });
          break;

        case 'reset-stop':
          if (resetState) {
            stopReset(resetState, posMap);
            scheduler.unregister('reset');
            resetState = null;
            if (renderState) renderState.smoothMotion = false;
            pushArrangement(arrangements, 'x-relax', posMap);
            updateHud();
            fullRender();
          }
          break;

        case 'arrangement-back-start':
          arrangementTravelState = startArrangementTravel(arrangements, posMap, 'back', 600);
          if (arrangementTravelState) {
            if (renderState) renderState.smoothMotion = true;
            updateHud();
            scheduler.register('arrangement-travel', (dt) => {
              if (!arrangementTravelState) return;
              if (updateArrangementTravel(arrangementTravelState, dt, arrangements, posMap)) {
                updateHud();
              }
            });
          }
          break;

        case 'arrangement-back-stop':
          if (arrangementTravelState) {
            stopArrangementTravel(arrangementTravelState, arrangements, posMap);
            scheduler.unregister('arrangement-travel');
            arrangementTravelState = null;
            if (renderState) renderState.smoothMotion = false;
            updateHud();
            fullRender();
          }
          break;

        case 'time-travel-start':
          timeTravelState = startTimeTravel(action.shift);
          if (renderState) renderState.smoothMotion = true;
          scheduler.register('time-travel', (dt) => {
            if (!timeTravelState) return;
            const prevCursor = history.cursor;
            const { stepped } = updateTimeTravel(timeTravelState, dt, history);
            if (stepped) {
              rebuildGraphFromHistory();
              bus.emit('cursor-moved', { from: prevCursor, to: history.cursor });
            }
          });
          break;

        case 'time-travel-stop':
          if (timeTravelState) {
            stopTimeTravel(timeTravelState);
            scheduler.unregister('time-travel');
            timeTravelState = null;
            if (renderState) renderState.smoothMotion = false;
          }
          break;

        case 'time-step':
          stepOnce(history, action.delta);
          rebuildGraphFromHistory();
          bus.emit('cursor-moved', { from: history.cursor - action.delta, to: history.cursor });
          break;

        case 'branch-switch':
          switchBranchByDirection(history, action.delta);
          rebuildGraphFromHistory();
          break;

        case 'escape':
          if (traceState) {
            releaseTrace(traceState);
            scheduler.unregister('trace');
            clearTraceOverlay();
            traceState = null;
          }
          selection = clearSelection();
          bus.emit('selection-changed', { selected: selection.selected, primary: selection.primary });
          break;
      }
    });

    document.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      const action = keyUp(keyState, key);
      if (!action) return;

      switch (action.action) {
        case 'gather-stop':
          if (gatherState) {
            stopGather(gatherState);
            scheduler.unregister('gather');
            gatherState = null;
            pushArrangement(arrangements, 'gather', posMap);
            updateHud();
            fullRender();
          }
          break;

        case 'reset-stop':
          if (resetState) {
            stopReset(resetState, posMap);
            scheduler.unregister('reset');
            resetState = null;
            if (renderState) renderState.smoothMotion = false;
            pushArrangement(arrangements, 'x-relax', posMap);
            updateHud();
            fullRender();
          }
          break;

        case 'arrangement-back-stop':
          if (arrangementTravelState) {
            stopArrangementTravel(arrangementTravelState, arrangements, posMap);
            scheduler.unregister('arrangement-travel');
            arrangementTravelState = null;
            if (renderState) renderState.smoothMotion = false;
            updateHud();
            fullRender();
          }
          break;

        case 'time-travel-stop':
          if (timeTravelState) {
            stopTimeTravel(timeTravelState);
            scheduler.unregister('time-travel');
            timeTravelState = null;
          }
          break;

        case 'trace-release':
          if (traceState && !traceState.held) {
            releaseTrace(traceState);
            scheduler.unregister('trace');
            clearTraceOverlay();
            traceState = null;
          }
          break;
      }
    });
  }

  // Apply a position coordinate to posMap, creating the entry if missing.
  // Extracted so history replay can reuse the logic without importing from
  // layout/positions (which main.js already does elsewhere).
  function updatePosMapCoord(id, x, y) {
    let ps = posMap.positions.get(id);
    if (!ps) {
      ps = { x, y, t0x: x, t0y: y, sticky: false, locked: false };
      posMap.positions.set(id, ps);
    } else {
      ps.x = x;
      ps.y = y;
    }
  }

  // --- Rebuild graph state from history at current cursor ---
  function rebuildGraphFromHistory() {
    const eff = effectiveRows(history);
    const rows = eff.slice(0, history.cursor + 1);
    // Manual replay. posMap is intentionally preserved across rebuilds so
    // that nodes which re-enter the graph during time travel reappear at
    // their prior coordinates rather than snapping to a fresh seed.
    graph.state.nodes.clear();
    graph.state.edges.clear();
    graph.state.cursor = -1;
    for (const r of rows) {
      const { type, op, id } = r;
      if (type === 'NODE') {
        if (op === 'add') {
          graph.state.nodes.set(id, { id, kind: r.kind || 'unknown', label: r.label || id, importance: r.weight != null ? r.weight : 1, payload: r.payload || null });
          // Apply persisted coordinates if the add row carries them.
          if (r.payload && typeof r.payload.x === 'number' && typeof r.payload.y === 'number') {
            updatePosMapCoord(id, r.payload.x, r.payload.y);
          }
        } else if (op === 'update') {
          const existing = graph.state.nodes.get(id);
          if (existing) {
            if (r.kind != null) existing.kind = r.kind;
            if (r.label != null) existing.label = r.label;
            if (r.weight != null) existing.importance = r.weight;
          }
          // Position replay: drag/reset rows carry x,y in payload.
          if (r.payload && typeof r.payload.x === 'number' && typeof r.payload.y === 'number') {
            updatePosMapCoord(id, r.payload.x, r.payload.y);
          }
        } else if (op === 'remove') {
          graph.state.nodes.delete(id);
        }
      } else if (type === 'EDGE') {
        if (op === 'add') {
          graph.state.edges.set(id, { id, source: r.source, target: r.target, layer: r.layer || 'unknown', weight: r.weight != null ? r.weight : 1, directed: true });
        } else if (op === 'update') {
          const existing = graph.state.edges.get(id);
          if (existing) {
            if (r.weight != null) existing.weight = r.weight;
            if (r.layer != null) existing.layer = r.layer;
          }
        } else if (op === 'remove') {
          graph.state.edges.delete(id);
        }
      }
      graph.state.cursor = r.t;
    }
    rederive(graph, context.weights.affinity);
    fullRender();
  }

  // --- Set up render pump ---
  if (renderState) {
    scheduler.setRender(() => {
      renderPositions(renderState);
    });
  }

  // Wire arrangement nav buttons (if present in the DOM).
  if (typeof document !== 'undefined') {
    const arrNav = document.getElementById('arr-nav');
    if (arrNav) {
      const back = arrNav.querySelector('[data-arr=back]');
      const fwd = arrNav.querySelector('[data-arr=fwd]');
      if (back) back.addEventListener('click', () => {
        if (arrangements.cursor > 0) {
          arrangements.cursor -= 1;
          const arr = arrangements.stack[arrangements.cursor];
          if (arr) {
            for (const [id, p] of arr.positions) {
              const ps = posMap.positions.get(id);
              if (ps) { ps.x = p.x; ps.y = p.y; }
            }
          }
          updateHud();
          fullRender();
        }
      });
      if (fwd) fwd.addEventListener('click', () => {
        if (arrangements.cursor < arrangements.stack.length - 1) {
          arrangements.cursor += 1;
          const arr = arrangements.stack[arrangements.cursor];
          if (arr) {
            for (const [id, p] of arr.positions) {
              const ps = posMap.positions.get(id);
              if (ps) { ps.x = p.x; ps.y = p.y; }
            }
          }
          updateHud();
          fullRender();
        }
      });
    }
  }

  // --- Initial render ---
  pushArrangement(arrangements, 'initial', posMap);
  updateHud();
  fullRender();

  // Start the scheduler
  scheduler.start();

  // --- Phase 7: Streaming & Persistence ---
  let persistenceUnsub = null;
  let sseConnection = null;
  let cinematicState = null;

  // 7a: Wire localStorage persistence
  if (typeof window !== 'undefined' && opts.localStorage !== false) {
    persistenceUnsub = wirePersistence(bus, history, toCSV);
  }

  // 7c: Connect SSE for live updates (if URL provided or auto-detect)
  const sseUrl = opts.sseUrl || (typeof window !== 'undefined' ? '/history-events' : null);
  if (typeof window !== 'undefined' && sseUrl) {
    sseConnection = tryConnectSSE(sseUrl, (row) => {
      // Only apply rows we haven't seen (check timestamp)
      const eff = effectiveRows(history);
      const maxT = eff.length > 0 ? eff[eff.length - 1].t : -1;
      if (row.t > maxT) {
        appendRow(row);
      }
    }, {
      onOpen: () => console.log('[sse] connected'),
      onError: () => {}, // silent — offline-first
    });
  }

  // 7e: Cinematic mode (optional)
  if (opts.cinematic && svgCtx) {
    cinematicState = startCinematic(bus, {
      posMap,
      svgCtx,
      fullRender,
    });
  }

  // --- Public API ---
  const runtime = {
    bus,
    state: graph.state,
    context,
    scheduler,
    history,
    graph,
    posMap,
    svgCtx,
    selection: () => selection,
    fullRender,
    appendRow,
    // Phase 7: streaming
    sseConnection,
    cinematicState,
    enableCinematic() {
      if (cinematicState) return cinematicState;
      if (!svgCtx) return null;
      cinematicState = startCinematic(bus, { posMap, svgCtx, fullRender });
      return cinematicState;
    },
    disableCinematic() {
      stopCinematic(cinematicState);
      cinematicState = null;
    },
    destroy() {
      scheduler.stop();
      if (persistenceUnsub) persistenceUnsub();
      if (sseConnection) sseConnection.close();
      stopCinematic(cinematicState);
    },
  };

  return runtime;
}

// Proximity-based edge mid-stop opacity: solid when close, fades when far.
// Lifted from old_versions/index.html:3304 — the old "solid near ends, faded
// middle" look that made dense graphs legible.
export function edgeMidOpacity(dist) {
  const CLOSE = 60, FAR = 250;
  if (dist <= CLOSE) return 1.0;
  if (dist >= FAR) return 0.08;
  const t = (dist - CLOSE) / (FAR - CLOSE);
  return 1.0 - t * 0.92;
}

// Update gradient endpoints + mid-stop opacity in place.
export function updateGradientStops(grad, sx, sy, tx, ty) {
  grad.grad.setAttribute('x1', sx);
  grad.grad.setAttribute('y1', sy);
  grad.grad.setAttribute('x2', tx);
  grad.grad.setAttribute('y2', ty);
  const dx = tx - sx, dy = ty - sy;
  const midOp = edgeMidOpacity(Math.sqrt(dx * dx + dy * dy));
  grad.stops[0].setAttribute('stop-opacity', '1');
  grad.stops[1].setAttribute('stop-opacity', String(midOp));
  grad.stops[2].setAttribute('stop-opacity', String(midOp * 0.7));
  grad.stops[3].setAttribute('stop-opacity', String(midOp));
  grad.stops[4].setAttribute('stop-opacity', '1');
}

// Sanitize edge ids for use inside a CSS/SVG url(#...) reference.
function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function nodeColor(kind) {
  const colors = {
    function: '#4a90d9',
    global: '#e74c3c',
    module: '#2ecc71',
    cluster: '#9b59b6',
    parameter: '#f39c12',
    value: '#1abc9c',
  };
  return colors[kind] || '#95a5a6';
}

// Auto-init when loaded in the browser
if (typeof window !== 'undefined') {
  const runtime = init();
  window.__depgraph = runtime;
  console.log('depgraph runtime initialized', runtime);
}
