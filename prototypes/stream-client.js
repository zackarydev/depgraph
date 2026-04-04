// ── Stream client: frontend → backend append-only CSV log ────────────────
//
// Plan 2 Tier 1+2: every user action becomes a row in runtime/history.csv.
//
// Emission API (called from index.html user-action sites):
//   streamClient.emitAction(label, source, opts)   // stick/unstick/lock/…
//   streamClient.emitDistance(source, target, d)   // drag → observed distance
//   streamClient.emitUserEdge(source, target, w)   // user-grouping edge
//   streamClient.emitRemoveEdge(source, target, edgeType)
//   streamClient.flush()                           // force send now
//
// Rows are batched in memory and POSTed to /rows on a 250 ms debounce
// (or immediately when the queue hits 64 entries, or on flush()). The
// backend validates, appends to CSV, and rebroadcasts via /graph-events
// SSE so other open tabs see the same stream.
//
// Row shape matches the existing CSV columns exactly:
//   { t, type, label, source, target, importance_xi, cluster }
//
// Design notes:
//  - No external deps. No WebSocket yet (HTTP POST + existing SSE is enough
//    at the 500 ms drag-throttle rate and avoids a new protocol surface).
//  - clientId lets receivers ignore their own echoes on the rebroadcast.
//  - Emit sites are "pure producers": they never read state the caller
//    doesn't already have. No DOM access, no layout assumptions.
(function () {
  'use strict';

  const POST_URL = '/rows';
  const FLUSH_MS = 250;
  const MAX_BATCH = 64;

  // Stable per-tab id. Rebroadcast receivers compare this against incoming
  // rows' clientId to skip their own echoes.
  const clientId = 'c_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);

  const queue = [];
  let flushTimer = null;
  let inFlight = false;
  const remoteListeners = new Set();

  function scheduleFlush() {
    if (flushTimer || inFlight) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (queue.length === 0 || inFlight) return;
    const batch = queue.splice(0, queue.length);
    inFlight = true;
    fetch(POST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: batch, clientId }),
      keepalive: true, // allow flushing on page unload
    })
      .then((r) => {
        if (!r.ok) {
          return r.text().then((t) => { throw new Error('HTTP ' + r.status + ': ' + t); });
        }
      })
      .catch((e) => {
        // Drop-on-failure: the server is authoritative, retry logic would
        // complicate ordering. Log once; the user can inspect network tab.
        console.warn('[stream-client] send failed, dropped', batch.length, 'rows:', e.message);
      })
      .finally(() => {
        inFlight = false;
        if (queue.length > 0) scheduleFlush();
      });
  }

  function enqueue(row) {
    // Default the timestamp here so the moment of user action is what gets
    // recorded (not when the batch eventually sends).
    if (row.t == null) row.t = Date.now();
    queue.push(row);
    if (queue.length >= MAX_BATCH) flush();
    else scheduleFlush();
  }

  function emitAction(label, source, opts) {
    opts = opts || {};
    enqueue({
      type: 'ACTION',
      label,
      source,
      target: opts.target ?? '',
      importance_xi: opts.scaleFactor ?? '',
      cluster: opts.cluster ?? '',
    });
  }

  function emitDistance(source, target, distance) {
    enqueue({
      type: 'DISTANCE',
      label: 'spatial',
      source,
      target,
      importance_xi: distance,
      cluster: '',
    });
  }

  function emitUserEdge(source, target, weight) {
    enqueue({
      type: 'USER_EDGE',
      label: 'user-group',
      source,
      target,
      importance_xi: weight ?? '',
      cluster: '',
    });
  }

  function emitRemoveEdge(source, target, edgeType) {
    enqueue({
      type: 'REMOVE_EDGE',
      label: edgeType || '',
      source,
      target,
      importance_xi: '',
      cluster: '',
    });
  }

  function onRemoteRows(cb) {
    remoteListeners.add(cb);
    return () => remoteListeners.delete(cb);
  }

  // Called by the index.html SSE handler when a `rows-appended` event arrives.
  // Own-echoes are filtered here so listeners never see their own writes.
  function _handleRebroadcast(msg) {
    if (!msg || !Array.isArray(msg.rows)) return;
    if (msg.clientId === clientId) return; // skip own echo
    for (const cb of remoteListeners) {
      try { cb(msg); } catch (e) { console.warn('[stream-client] listener error:', e); }
    }
  }

  // Best-effort flush on navigation away.
  window.addEventListener('pagehide', () => { if (queue.length > 0) flush(); });
  window.addEventListener('beforeunload', () => { if (queue.length > 0) flush(); });

  window.streamClient = {
    clientId,
    emitAction,
    emitDistance,
    emitUserEdge,
    emitRemoveEdge,
    flush,
    onRemoteRows,
    _handleRebroadcast,
  };
})();
