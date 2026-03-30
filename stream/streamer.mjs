#!/usr/bin/env node
// CSV history streamer: pulls rows from an async source and pushes over SSE.
//
// The streamer has no knowledge of where data comes from.
// Sources are pluggable — see stream/sources/ for implementations.
//
// Source interface (async):
//   init()         → Promise<void>            prepare the source
//   header()       → string                   CSV header line
//   next(mode)     → Promise<string[] | null>  next chunk, null at EOF
//   reset()        → Promise<void>            rewind to beginning
//   close()        → void                     release resources
//
// Usage (standalone):
//   node stream/streamer.mjs [options]
//     --source=file         source type (default: file)
//     --file=path           CSV path for file source (default: runtime/history.csv)
//     --port=N              port (default: 3801)
//     --interval=N          ms between sends (default: 100)
//     --mode=line|tick      grouping mode (default: line)
//     --follow              keep tailing the file as it grows (for live-written files)
//     --loop                restart from beginning when source ends
//
// Usage (as module):
//   import { createStreamer } from './stream/streamer.mjs';
//   import { createFileSource } from './stream/sources/file.mjs';
//   const source = createFileSource('runtime/history.csv');
//   await source.init();
//   const streamer = createStreamer(source, { interval: 100, mode: 'tick' });
//   streamer.attachSSE(req, res);
//   streamer.start();

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

// ── Streamer core ─────────────────────────────────────
export function createStreamer(source, opts = {}) {
  const interval = opts.interval || 100;
  const mode = opts.mode || 'line';
  const loop = opts.loop ?? false;

  const clients = new Set();
  let timer = null;
  let sending = false; // guard against overlapping async sends
  let pending = false; // start() called but no clients yet
  let paused = false;

  function broadcast(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(msg); } catch { clients.delete(res); }
    }
  }

  async function sendNext() {
    if (sending || paused) return;
    sending = true;
    try {
      const batch = await source.next(mode);
      if (batch === null) {
        if (loop) {
          await source.reset();
        } else {
          broadcast({ type: 'end' });
          stop();
          return;
        }
      } else if (batch.length > 0) {
        broadcast({ type: 'rows', rows: batch });
      }
    } finally {
      sending = false;
    }
  }

  function start() {
    if (timer) return;
    if (clients.size === 0) {
      pending = true;
      console.log('[streamer] waiting for first client to connect…');
      return;
    }
    pending = false;
    broadcast({ type: 'header', columns: source.header() });
    timer = setInterval(sendNext, interval);
    console.log(`[streamer] streaming (mode=${mode}, interval=${interval}ms)`);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
      console.log('[streamer] stopped');
    }
  }

  function attachSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    if (pending) start();
  }

  function pause() {
    if (paused) return false;
    paused = true;
    broadcast({ type: 'paused' });
    console.log('[streamer] paused');
    return true;
  }

  function resume() {
    if (!paused) return false;
    paused = false;
    broadcast({ type: 'resumed' });
    console.log('[streamer] resumed');
    return true;
  }

  // Replay the last `tail` rows of the source.
  // Resets the source, sends all rows except the last `tail` as a bulk "base" message,
  // then streams the tail rows at the normal interval.
  async function replay(tail = 50) {
    // Stop current streaming
    stop();
    paused = false;

    // Read all rows from source
    await source.reset();
    const allRows = [];
    while (true) {
      const batch = await source.next('line');
      if (batch === null) break;
      allRows.push(...batch);
    }

    if (allRows.length <= tail) {
      // Not enough rows — just replay everything from scratch
      await source.reset();
      start();
      return { total: allRows.length, base: 0, tail: allRows.length };
    }

    const baseRows = allRows.slice(0, allRows.length - tail);
    const tailRows = allRows.slice(allRows.length - tail);

    // Send header + base as bulk load + tail marker
    broadcast({ type: 'header', columns: source.header() });
    // Send base rows in one big batch so the frontend builds the base graph quickly
    if (baseRows.length > 0) {
      broadcast({ type: 'rows', rows: baseRows });
    }
    // Signal that the base is done and streaming portion begins
    broadcast({ type: 'replay-tail', count: tailRows.length });

    // Now drip-feed the tail rows
    let idx = 0;
    timer = setInterval(() => {
      if (paused || sending) return;
      if (idx >= tailRows.length) {
        broadcast({ type: 'end' });
        stop();
        return;
      }
      // Use tick grouping: send all rows with same t value
      const row = tailRows[idx];
      const t = row.split(',', 1)[0];
      const batch = [row];
      idx++;
      while (idx < tailRows.length && tailRows[idx].split(',', 1)[0] === t) {
        batch.push(tailRows[idx]);
        idx++;
      }
      broadcast({ type: 'rows', rows: batch });
    }, interval);

    console.log(`[streamer] replay: ${baseRows.length} base, ${tailRows.length} tail`);
    return { total: allRows.length, base: baseRows.length, tail: tailRows.length };
  }

  return { start, stop, pause, resume, replay, attachSSE, clients, isPaused: () => paused };
}

// ── Spawn as subprocess ───────────────────────────────
export function spawnStreamer(opts = {}) {
  const args = [];
  if (opts.source) args.push(`--source=${opts.source}`);
  if (opts.file) args.push(`--file=${opts.file}`);
  if (opts.port) args.push(`--port=${opts.port}`);
  if (opts.interval) args.push(`--interval=${opts.interval}`);
  if (opts.mode) args.push(`--mode=${opts.mode}`);
  if (opts.loop) args.push('--loop');

  const child = fork(__filename, args, {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  return {
    child,
    kill() { child.kill(); },
    port: opts.port || 3801,
    url: `http://127.0.0.1:${opts.port || 3801}/stream`,
  };
}

// ── Standalone server ─────────────────────────────────
const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

if (IS_MAIN) {
  const args = process.argv.slice(2);
  const get = (key, def) => {
    const a = args.find(a => a.startsWith(`--${key}=`));
    return a ? a.split('=').slice(1).join('=') : def;
  };

  const port = parseInt(get('port', '3801'), 10);
  const sourceType = get('source', 'file');
  const file = get('file', 'runtime/hcsn.csv');
  const interval = parseInt(get('interval', '100'), 10);
  const mode = get('mode', 'line');
  const follow = args.includes('--follow');
  const loop = args.includes('--loop');

  // Resolve source
  let source;
  if (sourceType === 'file') {
    const { createFileSource } = await import('./sources/file.mjs');
    source = createFileSource(file, { follow });
  } else {
    console.error(`[streamer] unknown source type: ${sourceType}`);
    process.exit(1);
  }

  await source.init();

  const streamer = createStreamer(source, { interval, mode, loop });

  const CORS = { 'Access-Control-Allow-Origin': '*' };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/stream') {
      streamer.attachSSE(req, res);
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ status: 'ok', clients: streamer.clients.size, paused: streamer.isPaused() }));
      return;
    }

    // CORS preflight for POST endpoints
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return;
    }

    if (url.pathname === '/pause' && req.method === 'POST') {
      const ok = streamer.pause();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ paused: true, changed: ok }));
      return;
    }

    if (url.pathname === '/resume' && req.method === 'POST') {
      const ok = streamer.resume();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ paused: false, changed: ok }));
      return;
    }

    if (url.pathname === '/replay' && req.method === 'POST') {
      const tail = parseInt(url.searchParams.get('tail') || '50', 10);
      streamer.replay(tail).then(info => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify(info));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    res.writeHead(404, CORS);
    res.end('not found');
  });

  streamer.start(); // defers until first client connects

  server.listen(port, '127.0.0.1', () => {
    console.log(`[streamer] http://127.0.0.1:${port}/stream`);
    console.log(`  source   = ${sourceType}${sourceType === 'file' ? ` (${file})` : ''}`);
    console.log(`  interval = ${interval}ms`);
    console.log(`  mode     = ${mode}`);
    console.log(`  follow   = ${follow}`);
    console.log(`  loop     = ${loop}`);
  });
}
