#!/usr/bin/env node
// Tools dev server: static files + SSE for depgraph focus events
// Usage: node tools/depgraph-server.mjs [port]

import { createServer } from 'node:http';
import { readFile, watch } from 'node:fs';
import { join, extname, resolve } from 'node:path';

const PORT = parseInt(process.argv[2] || '3800', 10);
const EQUINOX = resolve(import.meta.dirname, '../Equinox');
const ROOT = resolve(import.meta.dirname, '.');
const FOCUS_FILE = join(import.meta.dirname, '/runtime/depgraph-focus.json');

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── SSE clients ────────────────────────────────────
const clients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}

// ── Watch focus file (macOS FSEvents via fs.watch) ─
let lastFocus = null;

function readFocus() {
  readFile(FOCUS_FILE, 'utf8', (err, text) => {
    if (err) return;
    try {
      const data = JSON.parse(text);
      const key = JSON.stringify(data);
      if (key === lastFocus) return;
      lastFocus = key;
      broadcast(data);
    } catch { /* malformed json, skip */ }
  });
}

watch(FOCUS_FILE, { persistent: true }, () => readFocus());
readFocus();

// ── HTTP server ────────────────────────────────────
function isLocal(req) {
  const remote = req.socket.remoteAddress;
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

const server = createServer((req, res) => {
  if (!isLocal(req)) {
    res.writeHead(403);
    res.end('localhost only');
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // SSE endpoint
  if (url.pathname === '/focus-events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write(`data: ${lastFocus || JSON.stringify({ focus: [] })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Static files (project root)
  const rootOrEquinox = url.pathname.includes('Equinox') ? EQUINOX : ROOT;
  const isEquinox = rootOrEquinox === EQUINOX;
  let filePath = join(ROOT, '/prototypes/depgraph.html');
  if(url.pathname !== '/') {
    filePath = isEquinox ? join(EQUINOX, url.pathname.replace('/Equinox', '')) : join(ROOT, url.pathname);
  }
  console.log(filePath);
  if (!rootOrEquinox) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\x1b[36mdepgraph\x1b[0m → http://127.0.0.1:${PORT}`);
  console.log(`  SSE    → /focus-events`);
  console.log(`  watch  → ${FOCUS_FILE}`);
});
