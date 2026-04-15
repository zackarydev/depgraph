#!/usr/bin/env node

/**
 * Depgraph development server.
 *
 * Three responsibilities (SPEC §4):
 *   1. Static file serving (the SPA)
 *   2. fs.watch on source + codemap → triggers producers → appends to history.csv
 *   3. SSE endpoint streaming new history rows to clients
 *
 * Usage:
 *   node depgraph-server.mjs [--port 3000] [--history runtime/history.csv] [--watch src/]
 *
 * @module depgraph-server
 */

import { createServer } from 'node:http';
import { readFile, stat, appendFile, readdir, watch } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { existsSync, createReadStream, statSync, watchFile, unwatchFile } from 'node:fs';

import { createWatcher } from './codegen/watcher.mjs';
import { appendHistory } from './codegen/graphgen.mjs';
import { validateRow } from './src/data/csv.js';

// ─── CLI args ────────────────────────────────────

const args = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}

const PORT = Number(argVal('--port', '3000'));
const HISTORY_PATH = resolve(argVal('--history', 'runtime/history.csv'));
const WATCH_DIR = argVal('--watch', null);
const ROOT = resolve('.');

// ─── MIME types ──────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.md':   'text/markdown; charset=utf-8',
  '.woff2':'font/woff2',
};

// ─── SSE client registry ─────────────────────────

/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ─── History tail watcher ────────────────────────

let lastHistorySize = 0;

function initHistorySize() {
  try {
    if (existsSync(HISTORY_PATH)) {
      lastHistorySize = statSync(HISTORY_PATH).size;
    }
  } catch {
    lastHistorySize = 0;
  }
}

/**
 * Watch history.csv for new appended lines and broadcast them via SSE.
 */
function watchHistory() {
  if (!existsSync(HISTORY_PATH)) return;

  initHistorySize();

  // Use polling-based watch for cross-platform reliability
  const POLL_INTERVAL = 500; // ms
  let watching = true;

  const check = async () => {
    if (!watching) return;
    try {
      const s = statSync(HISTORY_PATH);
      if (s.size > lastHistorySize) {
        // Read new bytes
        const stream = createReadStream(HISTORY_PATH, {
          start: lastHistorySize,
          encoding: 'utf-8',
        });
        let chunk = '';
        for await (const data of stream) {
          chunk += data;
        }
        lastHistorySize = s.size;

        // Split into lines and broadcast each
        const lines = chunk.split('\n').filter(l => l.trim());
        for (const line of lines) {
          broadcastSSE({ type: 'row', line });
        }
      }
    } catch {
      // file may not exist yet
    }
    if (watching) setTimeout(check, POLL_INTERVAL);
  };

  check();
  return () => { watching = false; };
}

// ─── Source file watcher ─────────────────────────

let watchAbort = null;

async function watchSources() {
  if (!WATCH_DIR) return;
  const dir = resolve(WATCH_DIR);

  // Phase 10f: drive the universal repo watcher. Every file change becomes
  // history rows, which append to history.csv, which the SSE tail picks up
  // and pushes to the browser. The browser's existing /history-events
  // consumer treats these like any other rows.
  const repoWatcher = createWatcher(dir, {
    onRows(rows) {
      let t = Date.now();
      const stamped = [];
      for (const r of rows) {
        const row = { ...r, t: t++ };
        if (!validateRow(row)) stamped.push(row);
      }
      if (stamped.length) {
        appendHistory(HISTORY_PATH, stamped);
        console.log(`[watch] +${stamped.length} rows → history.csv`);
      }
    },
  });
  repoWatcher.seed();

  try {
    const ac = new AbortController();
    watchAbort = ac;
    const watcher = watch(dir, { recursive: true, signal: ac.signal });
    for await (const event of watcher) {
      if (!event.filename) continue;
      if (event.filename.includes('node_modules') || event.filename.includes('.git/')) continue;
      if (event.filename.endsWith('history.csv')) continue;
      const abs = resolve(dir, event.filename);
      try {
        const s = statSync(abs);
        if (s.isFile()) repoWatcher.feed(abs);
      } catch {
        repoWatcher.remove(abs);
      }
      broadcastSSE({ type: 'source-changed', file: event.filename });
      console.log(`[watch] ${event.eventType}: ${event.filename}`);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[watch] error:', err.message);
    }
  }
}

// ─── HTTP server ─────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ─── SSE: /history-events ───
  if (pathname === '/history-events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });

    // Send initial history if requested
    if (url.searchParams.has('replay')) {
      try {
        const csv = await readFile(HISTORY_PATH, 'utf-8');
        const lines = csv.split('\n').filter(l => l.trim());
        // Skip header
        const start = lines[0] && lines[0].startsWith('t,type,') ? 1 : 0;
        for (let i = start; i < lines.length; i++) {
          res.write(`data: ${JSON.stringify({ type: 'row', line: lines[i] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'replay-done' })}\n\n`);
      } catch {
        res.write(`data: ${JSON.stringify({ type: 'replay-done' })}\n\n`);
      }
    }
    return;
  }

  // ─── POST: /history-append ───
  if (pathname === '/history-append' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      // Append raw CSV line(s) to history file
      const lines = body.trim();
      if (lines) {
        await appendFile(HISTORY_PATH, lines + '\n', 'utf-8');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── GET: /history ───
  if (pathname === '/history' && req.method === 'GET') {
    try {
      const csv = await readFile(HISTORY_PATH, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(csv);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No history file found');
    }
    return;
  }

  // ─── Static file serving ───
  let filePath = join(ROOT, pathname === '/' ? 'index.html' : pathname);

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    const ext = extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

// ─── Start ───────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n  depgraph server`);
  console.log(`  ───────────────`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  SSE:     /history-events`);
  console.log(`  History: ${HISTORY_PATH}`);
  if (WATCH_DIR) console.log(`  Watch:   ${resolve(WATCH_DIR)}`);
  console.log('');
});

// Start watchers
const stopHistoryWatch = watchHistory();
watchSources();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (stopHistoryWatch) stopHistoryWatch();
  if (watchAbort) watchAbort.abort();
  for (const res of sseClients) {
    try { res.end(); } catch {}
  }
  server.close(() => process.exit(0));
});

export { server, broadcastSSE, sseClients };
