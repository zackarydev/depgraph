/**
 * Phase 6.5: full boot pipeline.
 *
 * Loads history (demo or CSV), derives clusters, places nodes via
 * gradient descent, renders via fractal engine, wires interactions.
 *
 * @module main
 */

import { createBus } from './core/bus.js';
import { createScheduler } from './core/animation.js';
import { createContext } from './core/context.js';
import { createHistory, load as loadHistory, append as historyAppend, effectiveRows } from './data/history.js';
import { buildFromHistory, applyRowToGraph, rederive } from './data/graph-builder.js';
import { initialPlace } from './layout/placement.js';
import { warmRestart } from './layout/warm-restart.js';
import { initSVG } from './render/svg.js';
import {
  createLegacyRenderer,
  renderFull as legacyRenderFull,
  renderPositionsOnly as legacyRenderPositions,
  applySemanticZoom as legacyApplySemanticZoom,
  setShowFlag as legacySetShowFlag,
  renderSelectionGlow as legacyRenderSelectionGlow,
  clusterColor,
} from './render/legacy.js';
import { generateDemoHistory } from './data/demo-history.js';
import { EDGE_LAYERS, setLayerVisible, getLayer } from './edges/layers.js';
import { createSelection, selectNode, toggleSelection, clearSelection } from './interact/select.js';
import { endDrag } from './interact/drag.js';
import { toggleClusterStretchRule, clusterMembers as resolveClusterMembers } from './rules/cluster-rules.js';
import { setStretchBias } from './layout/gradient.js';
import { createKeyState, keyDown, keyUp } from './interact/keyboard.js';
import { startTrace, updateTrace, revealedNodes, releaseTrace, holdTrace, changeDirection } from './interact/trace.js';
import { createDispatcher, registerRule, emit as emitMoment, retract as retractMoment, tick as tickDispatcher } from './core/dispatcher.js';
import { gatherRule, gatherCentroid, neighborsOf } from './rules/gather.js';
import { dragRule, nodeDragOffsets, clusterDragOffsets } from './rules/drag.js';
import { relaxRule } from './rules/relax.js';
import { arrangementPullRule } from './rules/arrangement-pull.js';
import {
  SENTINEL_MOUSE_CLICKED,
  CLICK_EDGE_LAYER,
  clickEdgeId,
  sentinelRow,
  lastClickTarget,
} from './rules/click-events.js';
import { updatePosition, setLocked } from './layout/positions.js';
import { startTimeTravel, updateTimeTravel, stopTimeTravel, stepOnce, switchBranchByDirection } from './interact/time-travel.js';
import { createArrangementStack, pushArrangement, startTravel as startArrangementTravel, stopTravel as stopArrangementTravel } from './interact/arrangements.js';
import { loadFromLocal, wirePersistence } from './stream/local-persistence.js';
import { tryConnectSSE } from './stream/sse.js';
import { connectHistoryWS } from './stream/history-ws.js';
import { toCSV } from './data/history.js';
import { writeRowLine } from './data/csv.js';
import { startCinematic, stopCinematic } from './stream/cinematic.js';

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

  // --- History WebSocket (fire-and-forget append channel) ---
  // User-authored rows go straight to the server as text frames. The server
  // batches and flushes to history.csv every ~30ms. Opening here means the
  // socket is ready by the time the first user interaction lands.
  let historyWS = null;
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    historyWS = connectHistoryWS(`${proto}//${window.location.host}/history-ws`);
  }

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

  // --- Click-event sentinel ---
  // The `mouse-clicked` sentinel node is how we record user clicks as edges
  // in the graph. Seed it once per history (idempotent) and lock it far off
  // screen so it never participates in layout. Every click becomes an
  // `event:click` edge from this sentinel to the clicked node — gather-start
  // and other interactions can then query the graph instead of a parallel
  // selection object.
  if (!graph.state.nodes.has(SENTINEL_MOUSE_CLICKED)) {
    const seeded = historyAppend(history, sentinelRow());
    applyRowToGraph(graph, seeded, context.weights.affinity);
  }
  // Place the sentinel at the world origin and lock it. It renders like any
  // other node so the user can see which node/cluster was last clicked via
  // the outgoing event:click edge. Locked so physics can't drag it around.
  updatePosition(posMap, SENTINEL_MOUSE_CLICKED, 0, 0);
  setLocked(posMap, SENTINEL_MOUSE_CLICKED, true);

  // --- SVG (browser only) ---
  let svgCtx = null;
  let legacyState = null;

  if (typeof document !== 'undefined') {
    const container = opts.container || document.getElementById('viewport');
    const existingSvg = container && container.querySelector('svg');
    if (existingSvg) existingSvg.remove();
    if (container) {
      svgCtx = initSVG(container);
    }
  }

  // --- Dirty flags (row-appended batching) ---
  // Appends during a frame just set these; the render pump picks them up
  // once per rAF. Collapses watcher/drag/SSE-replay bursts.
  let dirtyGraph = false;
  let dirtyHud = false;

  // --- Selection & interaction state ---
  let selection = createSelection();
  let keyState = createKeyState();
  let traceState = null;
  let timeTravelState = null;
  const arrangements = createArrangementStack();
  let currentZoom = 1;
  let highlightedSearchIds = new Set();

  // Live moments — every motion-producing interaction is a moment under the
  // dispatcher substrate. Kept as handles so handlers can retract precisely.
  /** @type {import('./core/moment.js').Moment|null} */
  let activeGatherMoment = null;
  /** @type {import('./core/moment.js').Moment|null} */
  let activeDragMoment = null;
  /** @type {null | { moment: import('./core/moment.js').Moment, primaryId: string|null, memberIds: string[], flavor: 'node'|'cluster', isGroup: boolean, clusterId: string|null }} */
  let activeDragContext = null;
  /** @type {import('./core/moment.js').Moment|null} */
  let activeRelaxMoment = null;
  /** @type {import('./core/moment.js').Moment|null} */
  let activeArrangementMoment = null;
  /** @type {'back' | 'fwd' | null} */
  let activeArrangementDirection = null;

  // --- Moment dispatcher (phase-12 substrate) ---
  // Holds live moments emitted by user interactions, file watchers, agents,
  // and the future runtime ticker. Each frame the dispatcher asks every live
  // moment's rule to contribute position deltas; they sum and apply in one pass.
  const dispatcher = createDispatcher({ producerId: 'ui' });
  registerRule(dispatcher, gatherRule);
  registerRule(dispatcher, dragRule);
  registerRule(dispatcher, relaxRule);
  registerRule(dispatcher, arrangementPullRule);

  // One always-on scheduler tick drives every live moment. Empty d.live is
  // a fast no-op, so running it each frame costs nothing when nothing is
  // interacting. Per-interaction scheduler entries are only needed for
  // non-dispatcher loops (trace, time-travel) whose motion isn't position
  // deltas.
  scheduler.register('dispatcher', (dt) => {
    tickDispatcher(dispatcher, dt, {
      posMap,
      edges: graph.state.edges,
      weights: context.weights.physics,
      arrangements,
    });
  });

  // --- Legacy render state (port of old_versions/index.html visuals) ---
  if (svgCtx) {
    legacyState = createLegacyRenderer(svgCtx);
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

  // --- Full re-render: delegate to the legacy renderer ---
  // Visuals mirror old_versions/index.html (cluster hulls with textPath,
  // proximity gradient edges, affinity rings, meta-edges) but the data
  // shapes are the new modular ones (graph.state, posMap, derivation).
  function fullRender() {
    if (!svgCtx || !legacyState) return;
    legacyRenderFull(legacyState, {
      graph,
      posMap,
      derivation: graph.derivation,
      context,
      selection,
    });
    applySearchHighlight();
  }

  // Recolors search matches + dims everything else. Called by fullRender
  // and the search input handler.
  function applySearchHighlight() {
    if (!legacyState) return;
    const any = highlightedSearchIds.size > 0;
    for (const [id, g] of legacyState.nodeElements) {
      const hit = highlightedSearchIds.has(id);
      g.setAttribute('opacity', any && !hit ? '0.15' : '1');
    }
    for (const [id, t] of legacyState.labelElements) {
      const hit = highlightedSearchIds.has(id);
      t.setAttribute('opacity', any && !hit ? '0.1' : t.getAttribute('opacity') || '1');
    }
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

  // --- Build history rows from a completed drag gesture. The rule has already
  // moved posMap into place; this function just snapshots final positions,
  // marks the dragged nodes sticky (node-drag flavor), and computes spatial
  // edges for the K-nearest neighbors. Cluster drags emit one position row
  // per member with no stickiness or spatial edges — matching legacy behavior.
  function buildDragRows(dctx, posMap) {
    if (!dctx) return [];
    if (dctx.flavor === 'cluster') {
      const rows = [];
      for (const id of dctx.memberIds) {
        const ps = posMap.positions.get(id);
        if (ps) {
          rows.push({
            type: 'NODE', op: 'update', id,
            payload: {
              x: ps.x, y: ps.y,
              author: 'user', action: 'cluster-drag',
              cluster: dctx.clusterId,
            },
          });
        }
      }
      return rows;
    }
    // Node drag: reuse endDrag for sticky + spatial-edge logic via a
    // synthesized legacy dragState shape (endDrag reads moved/nodeId/isGroup/offsets).
    const offsets = new Map();
    for (const id of dctx.memberIds) {
      if (id !== dctx.primaryId) offsets.set(id, {});
    }
    return endDrag({
      moved: true,
      nodeId: dctx.primaryId,
      isGroup: dctx.isGroup,
      offsets,
    }, posMap);
  }

  // --- Emit a click event as an edge from the mouse-clicked sentinel to
  //     the target node. Persists to history; downstream consumers query the
  //     graph's edges for the most recent `event:click` to learn selection.
  function emitClickEvent(targetId, extra) {
    if (!targetId) return;
    const t = history.nextT;
    return appendRow({
      type: 'EDGE',
      op: 'add',
      id: clickEdgeId(t, targetId),
      source: SENTINEL_MOUSE_CLICKED,
      target: targetId,
      layer: CLICK_EDGE_LAYER,
      weight: 0,
      payload: {
        author: 'user',
        action: 'click',
        target: targetId,
        ...(extra || {}),
      },
    });
  }

  // --- Append row to history + update graph ---
  function appendRow(row) {
    const fullRow = historyAppend(history, row);
    applyRowToGraph(graph, fullRow, context.weights.affinity);

    // Place new nodes
    if (row.type === 'NODE' && row.op === 'add') {
      warmRestart(posMap, graph.state.nodes, graph.state.edges, context.weights.physics);
    }

    // Mirror user-authored rows to runtime/history.csv over the WebSocket.
    // Fire-and-forget: no ack, no await. The server batches writes. SSE still
    // echoes each appended line; the dedup-by-`t` path in the SSE handler
    // ignores our own echo.
    const author = fullRow.payload && fullRow.payload.author;
    if (author === 'user' && historyWS) {
      historyWS.send(writeRowLine(fullRow));
    }

    bus.emit('row-appended', { row: fullRow });
    return fullRow;
  }

  // --- Bus wiring ---
  // Row-appended is high-frequency (cluster drags, file watchers, SSE replay).
  // Setting flags here and letting the render pump collapse them into one
  // full-render per frame converts N appends into at most one fullRender.
  bus.on('row-appended', () => {
    dirtyGraph = true;
    dirtyHud = true;
  });

  bus.on('context-changed', ({ context: ctx }) => {
    rederive(graph, ctx.weights.affinity);
    fullRender();
  });

  bus.on('selection-changed', () => {
    renderSelectionRings();
    if (legacyState) {
      legacyRenderSelectionGlow(legacyState, selection);
    }
    updateInfoPanel();
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

  // --- Cluster label hit-test: walks DOM from the event target up to the
  // svg root, returns the clusterId (from data-cluster) if found. This is
  // cheaper and more reliable than geometric hit-testing against the
  // rendered <text> bbox, because we piggyback on SVG's own pointer routing.
  function clusterLabelFromEvent(event) {
    const t = event && event.target;
    if (!t || typeof t.closest !== 'function') return null;
    const el = t.closest('.cluster-label');
    if (!el) return null;
    return el.getAttribute('data-cluster');
  }

  // --- Descent burst: emit a scoped relax moment and auto-retract it after N
  // frames. Scoped bursts freeze everything outside the scope — cluster-local
  // collapse/expand must not pull bridge nodes around. The global X-reset key
  // emits a different, global relax moment; this burst is intentionally narrower.
  let descentBurstFrames = 0;
  /** @type {import('./core/moment.js').Moment|null} */
  let descentBurstMoment = null;
  function kickDescentBurst(frames = 60, scope = null, collapse = false) {
    descentBurstFrames = Math.max(descentBurstFrames, frames);
    const zoomEta = 0.25 / Math.max(0.5, Math.min(2, currentZoom));
    if (descentBurstMoment) {
      // A prior burst is still live — update its scope to the latest gesture
      // and extend its lifetime via the shared frame counter above.
      descentBurstMoment.payload.eta = zoomEta;
      descentBurstMoment.payload.scope = scope || undefined;
      descentBurstMoment.payload.collapse = !!collapse;
      return;
    }
    descentBurstMoment = emitMoment(dispatcher, {
      rule: 'relax',
      members: scope ? [...scope] : [],
      payload: {
        eta: zoomEta,
        scope: scope || undefined,
        collapse: !!collapse,
      },
      author: 'user',
    });
    scheduler.register('descent-burst-timer', () => {
      if (descentBurstFrames <= 0) {
        if (descentBurstMoment) {
          retractMoment(dispatcher, descentBurstMoment.id);
          descentBurstMoment = null;
        }
        scheduler.unregister('descent-burst-timer');
        return;
      }
      descentBurstFrames--;
    });
  }

  // --- Wire DOM events (6.5b) ---
  if (svgCtx) {
    const svg = svgCtx.svg;

    // Mouse state — declared early so the d3.zoom filter can reference it.
    let mouseDownTarget = null;
    let mouseDownPos = null;
    let isDragging = false;
    // Drag setup captured at mousedown. We emit the drag moment only once
    // the gesture crosses the click-vs-drag threshold, so bare clicks never
    // perturb posMap. Flavor selects between node / cluster-label drags.
    /** @type {null | { flavor: 'node'|'cluster', primaryId: string|null, clusterId: string|null, isGroup: boolean, memberIds: string[], offsets: Map<string,{dx:number,dy:number}> }} */
    let pendingDragSetup = null;

    // Track zoom changes for fractal LOD
    if (typeof d3 !== 'undefined' && d3.zoom) {
      const zoom = d3.zoom()
        .scaleExtent([0.1, 12])
        // Skip zoom/pan when the gesture starts on a node or cluster label —
        // those clicks belong to selection / drag / cluster toggle, not pan.
        // Wheel events always pass through, even over a label, so scrolling
        // still zooms the canvas regardless of cursor position.
        .filter((event) => {
          if (event.type === 'wheel') return true;
          if (event.type === 'mousedown' && event.button !== 0) return false;
          if (clusterLabelFromEvent(event)) return false;
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
          // Zoom-coupled stretch bias: log2(k) scaled down so moderate zoom
          // nudges layout distances without runaway expansion. Zoomed in →
          // positive bias (things spread); zoomed out → negative (things pack).
          setStretchBias(Math.log2(currentZoom) * 0.25);
          if (legacyState) {
            legacyApplySemanticZoom(legacyState, {
              graph, posMap, derivation: graph.derivation, context, selection,
            }, currentZoom);
          }
          if (Math.abs(currentZoom - prevZoom) / prevZoom > 0.25) {
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

      // Cluster label takes priority over node hit-test — labels are
      // rendered above nodes and the user explicitly grabbed the text.
      const clusterId = clusterLabelFromEvent(e);
      if (clusterId) {
        const memberSet = resolveClusterMembers(clusterId, graph);
        const offsets = clusterDragOffsets(memberSet, world.x, world.y, posMap);
        pendingDragSetup = {
          flavor: 'cluster',
          primaryId: null,
          clusterId,
          isGroup: false,
          memberIds: [...offsets.keys()],
          offsets,
        };
        mouseDownTarget = clusterId;
        mouseDownPos = { sx, sy, wx: world.x, wy: world.y };
        isDragging = false;
        emitClickEvent(clusterId, { kind: 'cluster', shiftKey: e.shiftKey });
        return;
      }

      const nodeId = hitTest(world.x, world.y);

      mouseDownTarget = nodeId;
      mouseDownPos = { sx, sy, wx: world.x, wy: world.y };
      isDragging = false;

      if (nodeId) {
        const isGroup = e.shiftKey && selection.selected.size > 1 && selection.selected.has(nodeId);
        const offsets = nodeDragOffsets(nodeId, posMap, isGroup ? selection.selected : null);
        pendingDragSetup = {
          flavor: 'node',
          primaryId: nodeId,
          clusterId: null,
          isGroup,
          memberIds: [...offsets.keys()],
          offsets,
        };
        emitClickEvent(nodeId, { kind: 'node', shiftKey: e.shiftKey });
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

      if (pendingDragSetup && isDragging) {
        if (!activeDragMoment) {
          // First frame past the click-vs-drag threshold: promote the pending
          // setup into a live drag moment. Dispatcher ticks will snap
          // members to anchor+offset thereafter.
          const setup = pendingDragSetup;
          activeDragMoment = emitMoment(dispatcher, {
            rule: 'drag',
            members: setup.memberIds,
            payload: {
              anchorX: world.x,
              anchorY: world.y,
              offsets: setup.offsets,
            },
            author: 'user',
          });
          activeDragContext = {
            moment: activeDragMoment,
            primaryId: setup.primaryId,
            memberIds: setup.memberIds,
            flavor: setup.flavor,
            isGroup: setup.isGroup,
            clusterId: setup.clusterId,
          };
        } else {
          activeDragMoment.payload.anchorX = world.x;
          activeDragMoment.payload.anchorY = world.y;
        }
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!mouseDownPos) return;
      if (activeDragMoment && isDragging) {
        // Snap to the final cursor position before we retract, so posMap
        // reflects the gesture end even if no rAF fired since last move.
        const rect = svg.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const world = screenToWorld(sx, sy);
        activeDragMoment.payload.anchorX = world.x;
        activeDragMoment.payload.anchorY = world.y;
        tickDispatcher(dispatcher, 16, {
          posMap,
          edges: graph.state.edges,
          weights: context.weights.physics,
          arrangements,
        });

        const dctx = activeDragContext;
        retractMoment(dispatcher, activeDragMoment.id);
        activeDragMoment = null;
        activeDragContext = null;

        const rows = buildDragRows(dctx, posMap);
        for (const row of rows) appendRow(row);
        if (rows.length > 0) {
          pushArrangement(arrangements, dctx.flavor === 'cluster' ? 'cluster-drag' : 'drag', posMap);
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
      pendingDragSetup = null;
    });

    // Double-click: on a cluster label → cycle stretch (collapse/default/expand)
    // and fire a descent burst so the physics animates the transition.
    svg.addEventListener('dblclick', (e) => {
      const clusterId = clusterLabelFromEvent(e);
      if (!clusterId) return;
      e.preventDefault();
      e.stopPropagation();
      // Resolve members BEFORE applying the rule so the scope is captured
      // from the pre-mutation derivation — safer against any rederive side
      // effects that might touch cluster membership.
      const memberScope = resolveClusterMembers(clusterId, graph);
      const { rows, next } = toggleClusterStretchRule(clusterId, graph);
      for (const row of rows) appendRow(row);
      // Trigger burst if we have edges to stretch OR members to centroid-pull.
      if (rows.length > 0 || memberScope.size > 0) {
        if (legacyState) legacyState.clusterLabelOffset.delete(clusterId);
        // If a global relax (X) is live, keep burst global so both reach
        // equilibrium together; otherwise scope to the cluster members.
        const scope = activeRelaxMoment ? null : memberScope;
        const isCollapse = next < -0.5;
        kickDescentBurst(200, scope, isCollapse);
        pushArrangement(arrangements, 'cluster-toggle', posMap);
        updateHud();
      }
    }, true);

    // Keyboard events
    document.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
      const action = keyDown(keyState, key, mods);
      if (!action) return;

      switch (action.action) {
        case 'gather-start': {
          // Under the substrate: gather is just an emit. Members + target are
          // derived from selection; the rule owns the pull math.
          let members = null;
          let target = null;

          // Cluster path: query the graph for the most recent click. If it
          // landed on a cluster label (a derivation.clusters key), pull the
          // cluster's members toward their centroid. This replaces the
          // missing cluster branch in the old `selection`-object world.
          const lastClicked = lastClickTarget(graph);
          const isCluster = lastClicked
            && graph.derivation
            && graph.derivation.clusters
            && graph.derivation.clusters.has(lastClicked);
          if (isCluster) {
            const cm = resolveClusterMembers(lastClicked, graph);
            if (cm && cm.size >= 2) {
              members = [...cm];
              target = gatherCentroid(members, posMap);
            }
          }

          if (!members && selection.selected.size >= 2) {
            members = [...selection.selected];
            target = gatherCentroid(members, posMap);
          } else if (!members && selection.primary) {
            members = neighborsOf(selection.primary, graph.state.edges, selection.selected);
            const ps = posMap.positions.get(selection.primary);
            if (ps) target = { x: ps.x, y: ps.y };
          }
          if (members && members.length > 0 && target) {
            activeGatherMoment = emitMoment(dispatcher, {
              rule: 'gather',
              members,
              payload: { targetX: target.x, targetY: target.y, strength: 3.0 },
              author: 'user',
            });
          }
          break;
        }

        case 'gather-stop':
          if (activeGatherMoment) {
            retractMoment(dispatcher, activeGatherMoment.id);
            activeGatherMoment = null;
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
          // X-key relaxation: global descent step per tick, unsticking as it
          // goes. Ctrl+X is weights-reset and handled elsewhere; skip here.
          if (action.ctrl) break;
          if (!activeRelaxMoment) {
            activeRelaxMoment = emitMoment(dispatcher, {
              rule: 'relax',
              members: [],
              payload: { eta: 0.25, clearSticky: true },
              author: 'user',
            });
            if (legacyState) legacyState.smoothMotion = true;
          }
          break;

        case 'reset-stop':
          if (activeRelaxMoment) {
            retractMoment(dispatcher, activeRelaxMoment.id);
            activeRelaxMoment = null;
            if (legacyState) legacyState.smoothMotion = false;
            pushArrangement(arrangements, 'x-relax', posMap);
            updateHud();
            fullRender();
          }
          break;

        case 'arrangement-back-start':
          // Delegate initial-step bookkeeping (push 'z-pending', snap one
          // back) to the legacy helper, then emit the walker moment which
          // advances the cursor every stepMs thereafter.
          if (!activeArrangementMoment) {
            const travel = startArrangementTravel(arrangements, posMap, 'back', 600);
            if (travel) {
              activeArrangementMoment = emitMoment(dispatcher, {
                rule: 'arrangement-pull',
                members: [],
                payload: { direction: 'back', stepMs: 600 },
                author: 'user',
              });
              activeArrangementDirection = 'back';
              if (legacyState) legacyState.smoothMotion = true;
              updateHud();
            }
          }
          break;

        case 'arrangement-back-stop':
          if (activeArrangementMoment) {
            retractMoment(dispatcher, activeArrangementMoment.id);
            activeArrangementMoment = null;
            // Legacy stopTravel bookkeeping: rename or drop z-pending marker.
            stopArrangementTravel(
              { active: true, elapsed: 0, stepMs: 600, direction: activeArrangementDirection || 'back' },
              arrangements,
              posMap,
            );
            activeArrangementDirection = null;
            if (legacyState) legacyState.smoothMotion = false;
            updateHud();
            fullRender();
          }
          break;

        case 'time-travel-start':
          timeTravelState = startTimeTravel(action.shift);
          if (legacyState) legacyState.smoothMotion = true;
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
            if (legacyState) legacyState.smoothMotion = false;
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
          if (activeGatherMoment) {
            retractMoment(dispatcher, activeGatherMoment.id);
            activeGatherMoment = null;
            pushArrangement(arrangements, 'gather', posMap);
            updateHud();
            fullRender();
          }
          break;

        case 'reset-stop':
          if (activeRelaxMoment) {
            retractMoment(dispatcher, activeRelaxMoment.id);
            activeRelaxMoment = null;
            if (legacyState) legacyState.smoothMotion = false;
            pushArrangement(arrangements, 'x-relax', posMap);
            updateHud();
            fullRender();
          }
          break;

        case 'arrangement-back-stop':
          if (activeArrangementMoment) {
            retractMoment(dispatcher, activeArrangementMoment.id);
            activeArrangementMoment = null;
            stopArrangementTravel(
              { active: true, elapsed: 0, stepMs: 600, direction: activeArrangementDirection || 'back' },
              arrangements,
              posMap,
            );
            activeArrangementDirection = null;
            if (legacyState) legacyState.smoothMotion = false;
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
  // Checks dirty flags before the position-only pass. Full rebuilds are
  // expensive; position/selection renders are cheap and run every frame.
  if (legacyState) {
    scheduler.setRender(() => {
      if (dirtyGraph) {
        dirtyGraph = false;
        fullRender();
      }
      if (dirtyHud) {
        dirtyHud = false;
        updateHud();
      }
      legacyRenderPositions(legacyState, { posMap });
      renderSelectionRings();
    });
  }

  // --- Info panel: populated on selection-changed ---
  function updateInfoPanel() {
    if (typeof document === 'undefined') return;
    const panel = document.getElementById('info-panel');
    if (!panel) return;
    const nameEl = document.getElementById('info-name');
    const bodyEl = document.getElementById('info-body');
    const primary = selection.primary;
    if (!primary) {
      panel.classList.remove('open');
      if (nameEl) nameEl.textContent = 'Select a node';
      if (bodyEl) bodyEl.innerHTML = '';
      return;
    }
    const node = graph.state.nodes.get(primary);
    if (!node) { panel.classList.remove('open'); return; }
    panel.classList.add('open');
    if (nameEl) nameEl.textContent = node.label || node.id;

    const parts = [];
    parts.push(`<div class="section"><div class="section-title">Kind</div><span class="tag">${escapeHtml(node.kind || 'unknown')}</span></div>`);

    const affs = graph.derivation && graph.derivation.affinities && graph.derivation.affinities.get(primary);
    if (affs && affs.size) {
      const sorted = [...affs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
      let rows = '';
      for (const [gid, w] of sorted) {
        const pct = Math.round(w * 100);
        const col = clusterColor(gid);
        rows += `<div class="affinity-row"><div class="affinity-bar" style="width:${Math.max(4, pct)}px;background:${col}"></div><span style="color:#aaa">${escapeHtml(String(gid)).slice(0, 28)}</span><span style="color:#555;margin-left:auto">${pct}%</span></div>`;
      }
      parts.push(`<div class="section"><div class="section-title">Affinities</div>${rows}</div>`);
    }

    const outgoing = [];
    const incoming = [];
    for (const edge of graph.state.edges.values()) {
      if (edge.source === primary) outgoing.push(edge);
      else if (edge.target === primary) incoming.push(edge);
    }
    if (outgoing.length) {
      const list = outgoing.slice(0, 12).map(e => `<span class="tag">→ ${escapeHtml(e.target)} <span style="color:#555">[${escapeHtml(e.layer)}]</span></span>`).join('');
      parts.push(`<div class="section"><div class="section-title">Outgoing (${outgoing.length})</div>${list}</div>`);
    }
    if (incoming.length) {
      const list = incoming.slice(0, 12).map(e => `<span class="tag">${escapeHtml(e.source)} → <span style="color:#555">[${escapeHtml(e.layer)}]</span></span>`).join('');
      parts.push(`<div class="section"><div class="section-title">Incoming (${incoming.length})</div>${list}</div>`);
    }

    if (bodyEl) bodyEl.innerHTML = parts.join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- Chrome wiring: toolbar checkboxes, search, speed sliders, layer panel ---
  function setupChrome() {
    if (typeof document === 'undefined') return;

    const flagMap = [
      ['show-labels', 'labels'],
      ['show-hulls', 'hulls'],
      ['show-cluster-labels', 'clusterLabels'],
      ['show-boundary-labels', 'boundaryLabels'],
      ['show-meta-edges', 'metaEdges'],
    ];
    for (const [id, flag] of flagMap) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('change', () => {
        if (legacyState) legacySetShowFlag(legacyState, flag, el.checked);
        fullRender();
      });
    }

    const search = document.getElementById('search');
    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        highlightedSearchIds = new Set();
        if (q) {
          for (const [id, node] of graph.state.nodes) {
            const label = (node.label || '').toLowerCase();
            if (id.toLowerCase().includes(q) || label.includes(q)) {
              highlightedSearchIds.add(id);
            }
          }
        }
        applySearchHighlight();
      });
    }

    const speedSliders = [
      ['x-speed', 'x-speed-val'],
      ['z-speed', 'z-speed-val'],
      ['t-speed', 't-speed-val'],
    ];
    for (const [sId, vId] of speedSliders) {
      const slider = document.getElementById(sId);
      const valEl = document.getElementById(vId);
      if (!slider || !valEl) continue;
      const update = () => {
        const ms = parseInt(slider.value, 10);
        valEl.textContent = (ms / 1000).toFixed(1) + 's';
      };
      slider.addEventListener('input', update);
      update();
    }

    // Populate bottom-left layer panel.
    const pullPanel = document.getElementById('pull-layers');
    if (pullPanel) {
      let html = '<div class="pull-title">Edge layers</div>';
      for (const [id, layer] of EDGE_LAYERS) {
        const op = (context.weights.opacity && context.weights.opacity[id] != null)
          ? context.weights.opacity[id] : 1.0;
        html += `<div class="layer-row${layer.visible ? '' : ' disabled'}" data-layer="${escapeHtml(id)}">
          <span class="swatch" style="background:${layer.color}"></span>
          <span class="layer-name">${escapeHtml(id)}</span>
          <input type="range" class="pull-slider" min="0" max="100" value="${Math.round(op * 100)}">
          <span class="pull-val">${Math.round(op * 100)}</span>
        </div>`;
      }
      pullPanel.innerHTML = html;
      pullPanel.querySelectorAll('.layer-row').forEach(row => {
        const id = row.getAttribute('data-layer');
        const swatch = row.querySelector('.swatch');
        const name = row.querySelector('.layer-name');
        const slider = row.querySelector('.pull-slider');
        const valEl = row.querySelector('.pull-val');
        const toggle = () => {
          const layer = getLayer(id);
          if (!layer) return;
          setLayerVisible(id, !layer.visible);
          row.classList.toggle('disabled', !layer.visible);
          fullRender();
        };
        swatch.addEventListener('click', toggle);
        name.addEventListener('click', toggle);
        slider.addEventListener('input', () => {
          const v = parseInt(slider.value, 10);
          valEl.textContent = String(v);
          if (!context.weights.opacity) context.weights.opacity = {};
          context.weights.opacity[id] = v / 100;
          fullRender();
        });
      });
    }

    const infoClose = document.getElementById('info-close');
    if (infoClose) {
      infoClose.addEventListener('click', () => {
        selection = clearSelection();
        bus.emit('selection-changed', { selected: selection.selected, primary: selection.primary });
      });
    }
  }

  setupChrome();

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
      if (historyWS) historyWS.close();
      stopCinematic(cinematicState);
    },
  };

  return runtime;
}

// Auto-init when loaded in the browser
if (typeof window !== 'undefined') {
  // Try to load history.csv from the server before falling back to demo data.
  (async () => {
    let csv = null;
    try {
      const res = await fetch('/history');
      if (res.ok) csv = await res.text();
    } catch {
      // offline or no server — fall through to demo
    }
    const opts = csv ? { csv } : {};
    const runtime = init(opts);
    window.__depgraph = runtime;
    console.log('depgraph runtime initialized', csv ? '(from history.csv)' : '(demo)', runtime);
  })();
}
