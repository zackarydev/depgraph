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

  function broadcast(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(msg); } catch { clients.delete(res); }
    }
  }

  async function sendNext() {
    if (sending) return;
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

  return { start, stop, attachSSE, clients };
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
      res.end(JSON.stringify({ status: 'ok', clients: streamer.clients.size }));
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
