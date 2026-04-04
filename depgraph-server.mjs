#!/usr/bin/env node
// Tools dev server: static files + SSE for depgraph focus events
// Usage: node depgraph-server.mjs [port] [--simulate[=interval_ms]]

import { createServer } from 'node:http';
import { readFile, readFileSync, writeFile, watch, appendFile } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { exec } from 'node:child_process';
import { generateHistory } from './codegen/historygen.mjs';
import { startSimulation } from './codegen/simulator.mjs';

// Parse args: support --simulate and --simulate=2000
const args = process.argv.slice(2);
const simArg = args.find(a => a.startsWith('--simulate'));
const SIMULATE = !!simArg;
const SIM_INTERVAL = simArg && simArg.includes('=') ? parseInt(simArg.split('=')[1], 10) : 3000;


const PORT = parseInt(args.find(a => !a.startsWith('-')) || '3800', 10);
const ROOT = resolve(import.meta.dirname, '.');
const FOCUS_FILE = join(ROOT, 'runtime/depgraph-focus.json');

// ── Load inspect.json ─────────────────────────────
const INSPECT_FILE = join(ROOT, 'inspect.json');
const inspect = JSON.parse(readFileSync(INSPECT_FILE, 'utf8'));
const TARGET_SRC = resolve(ROOT, inspect.src);
const CODEMAP_FILE = resolve(ROOT, inspect.codemap);
console.log(`\x1b[33minspect\x1b[0m  ${inspect.name}`);
console.log(`  src    → ${TARGET_SRC}`);
console.log(`  map    → ${CODEMAP_FILE}`);

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

// ── Graph generation: watch src + codemap, regenerate CSVs ─
const HISTORY_FILE = join(ROOT, 'runtime/history.csv');
const graphClients = new Set();

function broadcastGraph(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of graphClients) {
    try { res.write(msg); } catch { graphClients.delete(res); }
  }
}

let graphgenTimer = null;
function triggerGraphgen() {
  clearTimeout(graphgenTimer);
  graphgenTimer = setTimeout(() => {
    try {
      const result = generateHistory(INSPECT_FILE);
      if (result) broadcastGraph({ type: 'graph-update', nodes: result.nNodes, edges: result.nEdges });
    } catch (e) {
      console.error('[historygen] error:', e.message);
    }
  }, 200); // debounce 200ms
}

if (SIMULATE) {
  // Simulation mode: generate evolving synthetic data instead of watching files
  console.log(`\x1b[35m[sim]\x1b[0m simulation mode enabled (interval: ${SIM_INTERVAL}ms)`);
  startSimulation(join(ROOT, 'runtime'), broadcastGraph, SIM_INTERVAL);
} else {
  // Normal mode: generate on startup, watch for file changes
  try { generateHistory(INSPECT_FILE); } catch (e) { console.error('[historygen] initial error:', e.message); }

  watch(TARGET_SRC, { persistent: true }, () => {
    console.log('[watch] src changed');
    triggerGraphgen();
  });
  watch(CODEMAP_FILE, { persistent: true }, () => {
    console.log('[watch] codemap changed');
    triggerGraphgen();
  });
}

// ── User-action row append (client → CSV) ─────────
// Frontend POSTs user actions (select/stick/lock/drag-distance/…) here.
// Rows are serialized to CSV and appended to history.csv, then rebroadcast
// over the existing /graph-events SSE so other tabs see them.
//
// Schema: { rows: [ {t, type, label, source, target, importance_xi, cluster} ], clientId }
//
// Allowed types and action labels are whitelisted so a buggy client cannot
// corrupt the log with unexpected row kinds.
const ALLOWED_ROW_TYPES = new Set(['ACTION', 'DISTANCE', 'USER_EDGE', 'REMOVE_EDGE']);
const ALLOWED_ACTION_LABELS = new Set([
  'stick', 'unstick', 'lock', 'unlock',
  'select', 'deselect',
  'expand', 'collapse',
  'importance',
]);

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowToCSVLine(r) {
  // Column order: t,type,label,source,target,importance_xi,cluster
  return [
    csvEscape(r.t),
    csvEscape(r.type),
    csvEscape(r.label),
    csvEscape(r.source),
    csvEscape(r.target),
    csvEscape(r.importance_xi),
    csvEscape(r.cluster),
  ].join(',');
}

function validateRow(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  if (!ALLOWED_ROW_TYPES.has(r.type)) return `type not allowed: ${r.type}`;
  if (r.type === 'ACTION' && !ALLOWED_ACTION_LABELS.has(r.label)) {
    return `ACTION label not allowed: ${r.label}`;
  }
  if (r.source == null || r.source === '') return 'source required';
  if (typeof r.t !== 'number' || !isFinite(r.t)) return 't must be a finite number';
  return null;
}

// User actions go to a separate append-only file. The main history.csv is
// regenerated by historygen on src/codemap changes (writeFileSync), so we
// cannot share it without losing the user-action log. Keeping the concerns
// separate is also the right boundary: history.csv describes code structure,
// user-actions.csv describes user interactions.
const USER_ACTIONS_FILE = join(ROOT, 'runtime/user-actions.csv');
const USER_ACTIONS_HEADER = 't,type,label,source,target,importance_xi,cluster\n';

// Serialized append queue — prevents interleaved writes under concurrent POSTs.
// Also ensures the header is written exactly once on first append.
let appendQueue = Promise.resolve();
let userActionsFileReady = false;
function ensureUserActionsFile() {
  if (userActionsFileReady) return Promise.resolve();
  return new Promise((resolve) => {
    readFile(USER_ACTIONS_FILE, 'utf8', (err, _data) => {
      if (err && err.code === 'ENOENT') {
        writeFile(USER_ACTIONS_FILE, USER_ACTIONS_HEADER, 'utf8', (werr) => {
          if (werr) console.error('[rows] init error:', werr.message);
          userActionsFileReady = true;
          resolve();
        });
      } else {
        userActionsFileReady = true;
        resolve();
      }
    });
  });
}

function appendRowsToCSV(lines) {
  const payload = lines.join('\n') + '\n';
  appendQueue = appendQueue.then(ensureUserActionsFile).then(() => new Promise((resolve) => {
    appendFile(USER_ACTIONS_FILE, payload, 'utf8', (err) => {
      if (err) console.error('[rows] append error:', err.message);
      resolve();
    });
  }));
  return appendQueue;
}

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

  // Append user-action rows to history.csv + rebroadcast to other clients
  if (url.pathname === '/rows' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) { req.destroy(); } });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      const rows = Array.isArray(parsed?.rows) ? parsed.rows : null;
      const clientId = typeof parsed?.clientId === 'string' ? parsed.clientId : '';
      if (!rows || rows.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'rows array required' }));
        return;
      }
      if (rows.length > 2000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'too many rows (max 2000)' }));
        return;
      }
      const errors = [];
      const lines = [];
      for (let i = 0; i < rows.length; i++) {
        const err = validateRow(rows[i]);
        if (err) { errors.push({ i, err }); continue; }
        lines.push(rowToCSVLine(rows[i]));
      }
      if (errors.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'validation failed', errors }));
        return;
      }
      appendRowsToCSV(lines).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify({ ok: true, count: lines.length }));
        // Rebroadcast to other tabs via existing /graph-events SSE.
        broadcastGraph({ type: 'rows-appended', rows, clientId });
      });
    });
    return;
  }

  // Cluster creation — immediately writes unnamed section, then renames async via Claude
  if (url.pathname === '/cluster' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { nodeIds, existingClusters, nodeDetails } = JSON.parse(body);
        const tempName = `Unnamed Cluster ${Date.now()}`;
        const section = `\n## ${tempName}\n<!-- user-cluster -->\n` +
          nodeIds.map(id => `- \`${id}\``).join('\n') + '\n';

        // Step 1: write placeholder immediately
        readFile(CODEMAP_FILE, 'utf8', (err, content) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'read error' }));
            return;
          }
          writeFile(CODEMAP_FILE, content.trimEnd() + '\n' + section, 'utf8', (err2) => {
            if (err2) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'write error' }));
              return;
            }
            // Respond immediately with the temp name
            console.log(`[cluster] created placeholder: ${tempName}`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
            res.end(JSON.stringify({ name: tempName }));

            // Step 2: spawn Claude in background to name it, then rename in codemap
            const prompt = [
              'You are naming a user-defined cluster of variables/functions in a dependency graph.',
              'The user has selected these functions to group together:',
              nodeIds.map(id => {
                const d = nodeDetails[id];
                if (!d) return `- ${id}`;
                return `- ${id} (system: ${d.system}, reads: ${d.reads}, writes: ${d.writes}, calls: ${d.calls})`;
              }).join('\n'),
              '',
              'Existing system clusters in this graph: ' + existingClusters.join(', '),
              '',
              'Give this cluster a short, descriptive name (4 words max) that captures what these functions have in common.',
              'The name should be distinct from the existing clusters listed above.',
              'Reply with ONLY the cluster name, nothing else.',
            ].join('\n');

            const escaped = prompt.replace(/'/g, "'\\''");
            exec(`claude -p '${escaped}' --model haiku`, {
              timeout: 30000,
              shell: '/bin/zsh',
            }, (err3, stdout, stderr) => {
              if (err3) {
                console.error('[cluster] claude naming error:', err3.message, stderr);
                return;
              }
              const finalName = stdout.trim().replace(/^["']|["']$/g, '');
              console.log(`[cluster] renaming "${tempName}" → "${finalName}"`);
              // Replace the temp name in codemap
              readFile(CODEMAP_FILE, 'utf8', (err4, current) => {
                if (err4) return;
                const updated = current.replace(`## ${tempName}`, `## ${finalName}`);
                if (updated !== current) {
                  writeFile(CODEMAP_FILE, updated, 'utf8', (err5) => {
                    if (err5) console.error('[cluster] rename write error:', err5.message);
                    else console.log(`[cluster] renamed to: ${finalName}`);
                  });
                }
              });
            });
          });
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // Delete a user cluster section from codemap
  if (url.pathname === '/cluster' && req.method === 'DELETE') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { sectionName } = JSON.parse(body);
        readFile(CODEMAP_FILE, 'utf8', (err, content) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'read error' }));
            return;
          }
          // Remove the section: from "## Name\n<!-- user-cluster -->" to next "## " or EOF
          const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`\\n## ${escaped}\\n<!-- user-cluster -->\\n(?:- [^\\n]*\\n?)*`, 'g');
          const updated = content.replace(re, '');
          if (updated === content) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'section not found' }));
            return;
          }
          writeFile(CODEMAP_FILE, updated, 'utf8', (err2) => {
            if (err2) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'write error' }));
              return;
            }
            console.log(`[cluster] deleted: ${sectionName}`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
            res.end(JSON.stringify({ deleted: true }));
          });
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

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

  // SSE endpoint for graph updates
  if (url.pathname === '/graph-events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    graphClients.add(res);
    req.on('close', () => graphClients.delete(res));
    return;
  }

  // Serve user-actions CSV (append-only log of user interactions)
  if (url.pathname === '/runtime/user-actions.csv') {
    readFile(USER_ACTIONS_FILE, (err, data) => {
      if (err && err.code === 'ENOENT') {
        res.writeHead(200, { 'Content-Type': 'text/csv', 'X-Content-Type-Options': 'nosniff' });
        res.end(USER_ACTIONS_HEADER);
        return;
      }
      if (err) { res.writeHead(500); res.end('error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/csv', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
    return;
  }

  // Serve history CSV (combined nodes + edges time-series)
  if (url.pathname === '/runtime/history.csv') {
    readFile(HISTORY_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end('history.csv not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/csv', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
    return;
  }

  // Serve inspect.json so the frontend can read it
  if (url.pathname === '/inspect.json') {
    readFile(INSPECT_FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('error'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
    return;
  }

  // Serve the target source file at /target/src
  if (url.pathname === '/target/src') {
    readFile(TARGET_SRC, (err, data) => {
      if (err) { res.writeHead(404); res.end('target src not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(TARGET_SRC)] || 'text/plain', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
    return;
  }

  // Static files (project root)
  let filePath = join(ROOT, '/prototypes/index.html');
  if (url.pathname !== '/') {
    filePath = join(ROOT, url.pathname);
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
  console.log(`  SSE    → /focus-events, /graph-events`);
  console.log(`  POST   → /rows (append user-action rows)`);
  console.log(`  CSV    → /runtime/history.csv, /runtime/user-actions.csv`);
  console.log(`  target → /target/src`);
  console.log(`  watch  → src, codemap, ${FOCUS_FILE}`);
});
