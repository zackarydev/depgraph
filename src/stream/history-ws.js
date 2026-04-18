/**
 * WebSocket sender for user-authored history rows.
 *
 * Fire-and-forget: each row is pushed as a text frame, no ack, no await.
 * The server buffers and batches writes to history.csv; the existing SSE
 * tail still echoes back to this client, where the row's `t` already matches
 * the local row and is deduplicated.
 *
 * If the socket isn't open yet, rows queue up to a small cap and flush on
 * open. A closed socket auto-reconnects after 1s.
 *
 * @module stream/history-ws
 */

const MAX_QUEUE = 10000;
const RECONNECT_MS = 1000;

/**
 * Open a WebSocket to the history endpoint.
 *
 * @param {string} url - e.g. `ws://localhost:3000/history-ws`
 * @returns {{ send: (line: string) => void, close: () => void, readonly connected: boolean }}
 */
export function connectHistoryWS(url) {
  if (typeof WebSocket === 'undefined') {
    return { send: () => {}, close: () => {}, get connected() { return false; } };
  }

  let ws = null;
  let open = false;
  let closed = false;
  const queue = [];

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      ws = null;
      setTimeout(connect, RECONNECT_MS);
      return;
    }
    ws.onopen = () => {
      open = true;
      for (const line of queue) {
        try { ws.send(line); } catch { break; }
      }
      queue.length = 0;
    };
    ws.onclose = () => {
      open = false;
      ws = null;
      if (!closed) setTimeout(connect, RECONNECT_MS);
    };
    ws.onerror = () => {
      // silent; onclose follows
    };
  }

  connect();

  return {
    send(line) {
      if (open && ws) {
        try { ws.send(line); return; } catch { /* fall through to queue */ }
      }
      if (queue.length < MAX_QUEUE) queue.push(line);
    },
    close() {
      closed = true;
      if (ws) {
        try { ws.close(); } catch {}
        ws = null;
      }
    },
    get connected() { return open; },
  };
}
