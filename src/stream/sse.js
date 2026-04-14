/**
 * Type B streaming: SSE client for live history updates.
 *
 * Connects to /history-events on the server and feeds each incoming
 * row through the same history.append() path as a user action.
 *
 * @module stream/sse
 */

import { parseLine, fieldsToRow } from '../data/csv.js';

/**
 * @typedef {Object} SSEConnection
 * @property {EventSource|null} source - the underlying EventSource
 * @property {boolean} connected - whether the connection is active
 * @property {Function} close - close the connection
 */

/**
 * Connect to the server's SSE history endpoint.
 *
 * @param {string} url - SSE endpoint URL (e.g. '/history-events' or 'http://localhost:3000/history-events')
 * @param {Function} onRow - called with each parsed HistoryRow
 * @param {Object} [options]
 * @param {Function} [options.onOpen] - called when connection opens
 * @param {Function} [options.onError] - called on connection error
 * @param {Function} [options.onReplayDone] - called when initial replay completes
 * @param {boolean} [options.replay=false] - request full history replay on connect
 * @returns {SSEConnection}
 */
export function connectSSE(url, onRow, options = {}) {
  const { onOpen, onError, onReplayDone, replay = false } = options;

  const fullUrl = replay ? `${url}?replay=true` : url;

  let source = null;
  let connected = false;

  try {
    source = new EventSource(fullUrl);
  } catch (err) {
    if (onError) onError(err);
    return { source: null, connected: false, close: () => {} };
  }

  source.onopen = () => {
    connected = true;
    if (onOpen) onOpen();
  };

  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'replay-done') {
        if (onReplayDone) onReplayDone();
        return;
      }

      if (data.type === 'row' && data.line) {
        const fields = parseLine(data.line);
        if (fields.length >= 4) {
          const row = fieldsToRow(fields);
          onRow(row);
        }
      }

      if (data.type === 'source-changed') {
        // Source file changed — could trigger re-generation
        // For now, just log it
        console.log('[sse] source changed:', data.file);
      }
    } catch (err) {
      console.warn('[sse] parse error:', err.message);
    }
  };

  source.onerror = (err) => {
    connected = false;
    if (onError) onError(err);
  };

  function close() {
    if (source) {
      source.close();
      source = null;
    }
    connected = false;
  }

  return {
    get source() { return source; },
    get connected() { return connected; },
    close,
  };
}

/**
 * Try to connect SSE, falling back silently if server is unavailable.
 * Returns a connection object or null.
 *
 * @param {string} url
 * @param {Function} onRow
 * @param {Object} [options]
 * @returns {SSEConnection|null}
 */
export function tryConnectSSE(url, onRow, options = {}) {
  if (typeof EventSource === 'undefined') {
    return null; // No SSE support (Node.js without polyfill)
  }

  return connectSSE(url, onRow, {
    ...options,
    onError: (err) => {
      // Silent on connection errors — offline-first
      if (options.onError) options.onError(err);
    },
  });
}
