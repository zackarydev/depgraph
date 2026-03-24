#!/usr/bin/env node
// Tools dev server: static files + SSE for depgraph focus events
// Usage: node tools/depgraph-server.mjs [port]

import { createServer } from 'node:http';
import { readFile, readFileSync, writeFile, watch } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { exec } from 'node:child_process';
import { generate as generateGraph } from './codegen/graphgen.mjs';

const PORT = parseInt(process.argv[2] || '3800', 10);
const ROOT = resolve(import.meta.dirname, '.');
const INSPECT_FILE = join(ROOT, 'inspect.json');
const FOCUS_FILE = join(ROOT, 'runtime/depgraph-focus.json');

// ── Load inspect.json ─────────────────────────────
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
const NODES_FILE = join(ROOT, 'runtime/nodes.csv');
const EDGES_FILE = join(ROOT, 'runtime/edges.csv');
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
      const result = generateGraph(INSPECT_FILE);
      if (result) broadcastGraph({ type: 'graph-update', nodes: result.nNodes, edges: result.nEdges });
    } catch (e) {
      console.error('[graphgen] error:', e.message);
    }
  }, 200); // debounce 200ms
}

// Generate on startup
try { generateGraph(INSPECT_FILE); } catch (e) { console.error('[graphgen] initial error:', e.message); }

// Watch source file and codemap for changes
watch(TARGET_SRC, { persistent: true }, () => {
  console.log('[watch] src changed');
  triggerGraphgen();
});
watch(CODEMAP_FILE, { persistent: true }, () => {
  console.log('[watch] codemap changed');
  triggerGraphgen();
});

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

  // Serve CSV files
  if (url.pathname === '/runtime/nodes.csv') {
    readFile(NODES_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end('nodes.csv not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/csv', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
    return;
  }
  if (url.pathname === '/runtime/edges.csv') {
    readFile(EDGES_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end('edges.csv not found'); return; }
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
  console.log(`  CSV    → /runtime/nodes.csv, /runtime/edges.csv`);
  console.log(`  target → /target/src`);
  console.log(`  watch  → src, codemap, ${FOCUS_FILE}`);
});
