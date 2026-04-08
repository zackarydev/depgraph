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
import { getLayer } from './edges/layers.js';

/**
 * Initialize the depgraph runtime.
 * @param {Object} [opts]
 * @param {string} [opts.csv] - CSV history string to load
 * @param {Element} [opts.container] - DOM element for SVG (default: #viewport)
 * @returns {Object} runtime handle
 */
export function init(opts = {}) {
  const bus = createBus();
  const context = createContext();
  const scheduler = createScheduler();

  // --- History ---
  let history;
  if (opts.csv) {
    history = loadHistory(opts.csv);
  } else {
    // Use demo history
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
  let currentZoom = 1;

  // --- Render state for the pump ---
  if (svgCtx) {
    renderState = {
      posMap,
      visibleNodes: new Set(),
      svgCtx,
      nodeElements: new Map(),
      labelElements: new Map(),
    };
  }

  // --- Full re-render from render plan ---
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

    // Render hulls
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

    // Render edges
    const gLinks = svgCtx.layers.gLinks;
    while (gLinks.firstChild) gLinks.removeChild(gLinks.firstChild);
    for (const edge of plan.edges) {
      const ps = posMap.positions.get(edge.source);
      const pt = posMap.positions.get(edge.target);
      if (!ps || !pt) continue;
      const layerDef = getLayer(edge.layer);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', ps.x);
      line.setAttribute('y1', ps.y);
      line.setAttribute('x2', pt.x);
      line.setAttribute('y2', pt.y);
      line.setAttribute('stroke', edge.isMeta ? '#ff0' : (layerDef ? layerDef.color : '#666'));
      line.setAttribute('stroke-width', edge.isMeta ? '2' : String(Math.max(0.5, Math.min(3, edge.weight))));
      line.setAttribute('stroke-opacity', edge.isMeta ? '0.7' : '0.5');
      if (edge.isMeta) line.setAttribute('stroke-dasharray', '6,3');
      else if (layerDef && layerDef.dash) line.setAttribute('stroke-dasharray', layerDef.dash);
      line.setAttribute('data-id', edge.id);
      gLinks.appendChild(line);
    }

    // Render nodes
    const nodeElements = new Map();
    const gNodes = svgCtx.layers.gNodes;
    while (gNodes.firstChild) gNodes.removeChild(gNodes.firstChild);
    for (const node of plan.nodes) {
      const ps = posMap.positions.get(node.id);
      if (!ps) continue;
      const r = node.isCluster ? 8 + node.importance : 4 + (node.importance || 1) * 2;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', ps.x);
      circle.setAttribute('cy', ps.y);
      circle.setAttribute('r', Math.min(r, 20));
      circle.setAttribute('fill', nodeColor(node.kind));
      circle.setAttribute('stroke', node.isCluster ? '#c9a' : '#fff');
      circle.setAttribute('stroke-width', node.isCluster ? '2' : '1');
      circle.setAttribute('stroke-opacity', '0.7');
      circle.setAttribute('data-id', node.id);
      circle.setAttribute('class', `node node-${node.kind}`);
      gNodes.appendChild(circle);
      nodeElements.set(node.id, circle);
    }

    // Render labels
    const labelElements = new Map();
    const gLabels = svgCtx.layers.gLabels;
    while (gLabels.firstChild) gLabels.removeChild(gLabels.firstChild);
    for (const node of plan.nodes) {
      const ps = posMap.positions.get(node.id);
      if (!ps) continue;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', ps.x);
      text.setAttribute('y', ps.y - 12);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', node.isCluster ? '11' : '9');
      text.setAttribute('fill', node.isCluster ? '#c9a' : '#aaa');
      text.setAttribute('font-weight', node.isCluster ? 'bold' : 'normal');
      text.textContent = node.label;
      gLabels.appendChild(text);
      labelElements.set(node.id, text);
    }

    // Cluster labels
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

    // Update render state for the position pump
    if (renderState) {
      renderState.nodeElements = nodeElements;
      renderState.labelElements = labelElements;
    }

    // Render selection rings
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

    // Track zoom changes for fractal LOD
    if (typeof d3 !== 'undefined' && d3.zoom) {
      // Re-wire zoom to also trigger re-render on zoom change
      const zoom = d3.zoom()
        .scaleExtent([0.1, 12])
        .on('zoom', (event) => {
          const t = event.transform;
          svgCtx.root.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
          svgCtx.transform = { x: t.x, y: t.y, k: t.k };
          const prevZoom = currentZoom;
          currentZoom = t.k;
          // Re-render on significant zoom change for LOD updates
          if (Math.abs(currentZoom - prevZoom) / prevZoom > 0.1) {
            fullRender();
          }
        });
      d3.select(svg).call(zoom);
    }

    // Mouse events for click/drag
    let mouseDownTarget = null;
    let mouseDownPos = null;
    let isDragging = false;

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
    });

    svg.addEventListener('mousemove', (e) => {
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
        // Position pump handles visual update
      }
    });

    svg.addEventListener('mouseup', (e) => {
      if (dragState && isDragging) {
        const rows = endDrag(dragState, posMap);
        for (const row of rows) {
          appendRow(row);
        }
        dragState = null;
      } else if (mouseDownTarget && !isDragging) {
        // Click (not drag)
        if (e.shiftKey) {
          selection = toggleSelection(selection, mouseDownTarget);
        } else {
          selection = selectNode(selection, mouseDownTarget);
        }
        bus.emit('selection-changed', { selected: selection.selected, primary: selection.primary });
      } else if (!mouseDownTarget && !isDragging) {
        // Click on empty space
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
          scheduler.register('reset', (dt) => {
            if (resetState) updateReset(resetState, dt, posMap);
          });
          break;

        case 'reset-stop':
          if (resetState) {
            stopReset(resetState, posMap);
            scheduler.unregister('reset');
            resetState = null;
            fullRender();
          }
          break;

        case 'time-travel-start':
          timeTravelState = startTimeTravel(action.shift);
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
            fullRender();
          }
          break;

        case 'reset-stop':
          if (resetState) {
            stopReset(resetState, posMap);
            scheduler.unregister('reset');
            resetState = null;
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

  // --- Rebuild graph state from history at current cursor ---
  function rebuildGraphFromHistory() {
    const eff = effectiveRows(history);
    const rows = eff.slice(0, history.cursor + 1);
    // Manual replay
    graph.state.nodes.clear();
    graph.state.edges.clear();
    graph.state.cursor = -1;
    for (const r of rows) {
      const { type, op, id } = r;
      if (type === 'NODE') {
        if (op === 'add') {
          graph.state.nodes.set(id, { id, kind: r.kind || 'unknown', label: r.label || id, importance: r.weight != null ? r.weight : 1, payload: r.payload || null });
        } else if (op === 'update') {
          const existing = graph.state.nodes.get(id);
          if (existing) {
            if (r.kind != null) existing.kind = r.kind;
            if (r.label != null) existing.label = r.label;
            if (r.weight != null) existing.importance = r.weight;
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

  // --- Initial render ---
  fullRender();

  // Start the scheduler
  scheduler.start();

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
  };

  return runtime;
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
