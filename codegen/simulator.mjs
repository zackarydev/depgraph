// Simulator: generates evolving synthetic graph data for testing realtime UI
// Usage: imported by depgraph-server.mjs when --simulate flag is set
//
// Design: models realistic codegen behavior. New functions always join an
// existing cluster and connect to cluster-mates. Globals are shared state
// that multiple functions read/write. Orphan nodes (no edges) are pruned.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Name generators ──────────────────────────────────

// Cluster-specific vocabulary so names reflect their cluster
const CLUSTER_VOCAB = {
  'Rendering':        { prefixes: ['render', 'draw', 'paint', 'display'], suffixes: ['Frame', 'Scene', 'Layer', 'Canvas', 'Sprite', 'Overlay'] },
  'Layout Engine':    { prefixes: ['layout', 'position', 'arrange', 'pack'], suffixes: ['Grid', 'Nodes', 'Bounds', 'Cells', 'Region', 'Cluster'] },
  'Data Processing':  { prefixes: ['process', 'transform', 'aggregate', 'filter'], suffixes: ['Data', 'Batch', 'Pipeline', 'Stream', 'Records', 'Chunk'] },
  'State Management': { prefixes: ['update', 'commit', 'revert', 'snapshot'], suffixes: ['State', 'Store', 'History', 'Undo', 'Delta', 'Patch'] },
  'Event Handling':   { prefixes: ['handle', 'emit', 'dispatch', 'on'], suffixes: ['Event', 'Click', 'Drag', 'Key', 'Gesture', 'Action'] },
  'Networking':       { prefixes: ['fetch', 'send', 'connect', 'sync'], suffixes: ['Request', 'Response', 'Socket', 'Channel', 'Endpoint', 'Payload'] },
  'Parsing':          { prefixes: ['parse', 'tokenize', 'extract', 'decode'], suffixes: ['Token', 'AST', 'Expr', 'Node', 'Block', 'Source'] },
  'Validation':       { prefixes: ['validate', 'check', 'verify', 'assert'], suffixes: ['Input', 'Schema', 'Rules', 'Constraint', 'Bounds', 'Type'] },
};

const GLOBAL_DEFS = [
  { name: 'appState',     cluster: 'State Management' },
  { name: 'currentConfig', cluster: 'State Management' },
  { name: 'eventBus',     cluster: 'Event Handling' },
  { name: 'renderQueue',  cluster: 'Rendering' },
  { name: 'nodeCache',    cluster: 'Data Processing' },
  { name: 'layoutGrid',   cluster: 'Layout Engine' },
  { name: 'dragState',    cluster: 'Event Handling' },
  { name: 'canvasCtx',    cluster: 'Rendering' },
  { name: 'parseBuffer',  cluster: 'Parsing' },
  { name: 'validationErrors', cluster: 'Validation' },
  { name: 'socketPool',   cluster: 'Networking' },
  { name: 'undoStack',    cluster: 'State Management' },
];

const CLUSTERS = Object.keys(CLUSTER_VOCAB);

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

// ── Simulation state ─────────────────────────────────
let tick = 0;
let nodes = [];     // { id, type, cluster, importance, line }
let edges = [];     // { source, target, type, weight }
let usedNames = new Set();
let nextLine = 1;

function genFuncName(cluster) {
  const vocab = CLUSTER_VOCAB[cluster];
  if (vocab) {
    for (let i = 0; i < 30; i++) {
      const name = pick(vocab.prefixes) + pick(vocab.suffixes);
      if (!usedNames.has(name)) { usedNames.add(name); return name; }
    }
  }
  // Fallback with number suffix
  const v = vocab || { prefixes: ['do'], suffixes: ['Thing'] };
  const name = pick(v.prefixes) + pick(v.suffixes) + randInt(1, 999);
  usedNames.add(name);
  return name;
}

// ── Core operations ──────────────────────────────────

function addFunction(cluster) {
  const id = genFuncName(cluster);
  nextLine += randInt(5, 40);
  const node = { id, type: 'function', cluster, importance: randInt(2, 8), line: nextLine };
  nodes.push(node);
  return node;
}

function addGlobal(def) {
  if (usedNames.has(def.name)) return null;
  usedNames.add(def.name);
  nextLine += randInt(1, 5);
  const node = { id: def.name, type: 'global', cluster: '', importance: 1, line: nextLine };
  nodes.push(node);
  return node;
}

function clusterMembers(cluster) {
  return nodes.filter(n => n.type === 'function' && n.cluster === cluster);
}

function globalsUsedByCluster(cluster) {
  const members = new Set(clusterMembers(cluster).map(n => n.id));
  const globals = new Set();
  for (const e of edges) {
    if ((e.type === 'uses' || e.type === 'writesTo') && members.has(e.source)) {
      globals.add(e.target);
    }
  }
  return [...globals].map(id => nodes.find(n => n.id === id)).filter(Boolean);
}

function addCallEdge(caller, callee) {
  // Avoid duplicate
  if (edges.some(e => e.source === caller.id && e.target === callee.id && e.type === 'calls')) return;
  edges.push({ source: caller.id, target: callee.id, type: 'calls', weight: 3 });
  edges.push({ source: callee.id, target: caller.id, type: 'calledBy', weight: 3 });
}

function addSharedEdge(a, b) {
  if (edges.some(e => e.source === a.id && e.target === b.id && e.type === 'shared')) return;
  edges.push({ source: a.id, target: b.id, type: 'shared', weight: randInt(1, 4) });
}

function addGlobalEdge(fn, global, type) {
  if (edges.some(e => e.source === fn.id && e.target === global.id && e.type === type)) return;
  edges.push({ source: fn.id, target: global.id, type, weight: 1 });
}

function removeNode(node) {
  usedNames.delete(node.id);
  nodes = nodes.filter(n => n !== node);
  edges = edges.filter(e => e.source !== node.id && e.target !== node.id);
}

function pruneOrphans() {
  // Remove any node with zero edges
  const connected = new Set();
  for (const e of edges) { connected.add(e.source); connected.add(e.target); }
  const orphans = nodes.filter(n => !connected.has(n.id));
  for (const o of orphans) {
    usedNames.delete(o.id);
  }
  nodes = nodes.filter(n => connected.has(n.id));
}

// ── Seed initial graph ───────────────────────────────
function seed() {
  nodes = [];
  edges = [];
  usedNames.clear();
  nextLine = 1;

  // Create globals first
  for (const def of GLOBAL_DEFS.slice(0, 8)) {
    addGlobal(def);
  }

  // Create 3-5 functions per cluster, wired together
  for (const cluster of CLUSTERS) {
    const count = randInt(3, 5);
    const members = [];
    for (let i = 0; i < count; i++) {
      members.push(addFunction(cluster));
    }

    // Wire intra-cluster: each function calls at least one cluster-mate
    for (let i = 1; i < members.length; i++) {
      addCallEdge(members[i], members[randInt(0, i - 1)]);
    }
    // Some shared-state edges within cluster
    for (let i = 0; i < members.length - 1; i++) {
      if (Math.random() < 0.4) addSharedEdge(members[i], members[i + 1]);
    }

    // Some members use relevant globals
    const relevantGlobals = GLOBAL_DEFS.filter(g => g.cluster === cluster)
      .map(g => nodes.find(n => n.id === g.name)).filter(Boolean);
    for (const fn of members) {
      for (const g of relevantGlobals) {
        if (Math.random() < 0.6) addGlobalEdge(fn, g, 'uses');
        if (Math.random() < 0.2) addGlobalEdge(fn, g, 'writesTo');
      }
    }
  }

  // A few cross-cluster calls
  const allFuncs = nodes.filter(n => n.type === 'function');
  for (let i = 0; i < 8; i++) {
    const a = pick(allFuncs), b = pick(allFuncs);
    if (a.cluster !== b.cluster) addCallEdge(a, b);
  }
}

// ── Tick: evolve the graph ───────────────────────────
function simulateTick() {
  tick++;
  const actions = randInt(1, 3);

  for (let i = 0; i < actions; i++) {
    const roll = Math.random();

    if (roll < 0.30) {
      // Add a function to an existing cluster, connected to cluster-mates
      const cluster = pick(CLUSTERS);
      const node = addFunction(cluster);
      const mates = clusterMembers(cluster).filter(n => n !== node);
      if (mates.length > 0) {
        // Always call at least one cluster-mate
        addCallEdge(node, pick(mates));
        // Maybe call a second
        if (mates.length > 1 && Math.random() < 0.4) {
          addCallEdge(node, pick(mates.filter(m => m.id !== node.id)));
        }
        // Maybe share state with a neighbor
        if (Math.random() < 0.3) addSharedEdge(node, pick(mates));
      }
      // Maybe use a cluster-relevant global
      const globals = globalsUsedByCluster(cluster);
      if (globals.length > 0 && Math.random() < 0.5) {
        addGlobalEdge(node, pick(globals), 'uses');
      }

    } else if (roll < 0.40) {
      // Add a cross-cluster call (represents new dependency)
      const allFuncs = nodes.filter(n => n.type === 'function');
      if (allFuncs.length >= 2) {
        const a = pick(allFuncs);
        const others = allFuncs.filter(n => n.cluster !== a.cluster);
        if (others.length > 0) addCallEdge(a, pick(others));
      }

    } else if (roll < 0.55) {
      // Remove a low-importance function (simulates refactoring away dead code)
      const candidates = nodes.filter(n => n.type === 'function' && n.importance <= 4);
      if (candidates.length > 0 && nodes.filter(n => n.type === 'function').length > 12) {
        removeNode(pick(candidates));
      }

    } else if (roll < 0.65) {
      // Bump importance of a function (it became more central)
      const funcs = nodes.filter(n => n.type === 'function');
      if (funcs.length > 0) {
        const node = pick(funcs);
        node.importance = Math.min(10, node.importance + randInt(1, 2));
      }

    } else if (roll < 0.75) {
      // Add a new intra-cluster edge (discovered shared state)
      const cluster = pick(CLUSTERS);
      const mates = clusterMembers(cluster);
      if (mates.length >= 2) {
        const a = pick(mates), b = pick(mates.filter(m => m !== a));
        if (Math.random() < 0.5) addSharedEdge(a, b);
        else addCallEdge(a, b);
      }

    } else if (roll < 0.85) {
      // Remove a random edge (refactor decouples two functions)
      const removable = edges.filter(e => e.type === 'calls' || e.type === 'shared');
      if (removable.length > 0) {
        const e = pick(removable);
        // Remove edge + its reverse (calledBy)
        edges = edges.filter(x => !(x.source === e.source && x.target === e.target && x.type === e.type));
        if (e.type === 'calls') {
          edges = edges.filter(x => !(x.source === e.target && x.target === e.source && x.type === 'calledBy'));
        }
      }

    } else {
      // Move a function to a neighboring cluster (refactor)
      const allFuncs = nodes.filter(n => n.type === 'function');
      if (allFuncs.length > 0) {
        const fn = pick(allFuncs);
        // Find clusters it has edges into
        const calledClusters = new Set();
        for (const e of edges) {
          if (e.source === fn.id && e.type === 'calls') {
            const target = nodes.find(n => n.id === e.target);
            if (target && target.cluster !== fn.cluster) calledClusters.add(target.cluster);
          }
        }
        if (calledClusters.size > 0) {
          fn.cluster = pick([...calledClusters]);
        }
      }
    }
  }

  // Always prune orphans after mutations
  pruneOrphans();
}

// ── CSV output ───────────────────────────────────────
function nodesCSV() {
  return nodes.map(n =>
    `${n.id},${n.type},${n.cluster},${n.importance},${n.line}`
  ).join('\n');
}

function edgesCSV() {
  return edges.map(e =>
    `${e.source},${e.target},${e.type},${e.weight}`
  ).join('\n');
}

// ── Public API ───────────────────────────────────────
export function startSimulation(runtimeDir, broadcastFn, intervalMs = 3000) {
  seed();

  // Write initial state
  const nodesFile = join(runtimeDir, 'nodes.csv');
  const edgesFile = join(runtimeDir, 'edges.csv');
  writeFileSync(nodesFile, nodesCSV(), 'utf8');
  writeFileSync(edgesFile, edgesCSV(), 'utf8');
  broadcastFn({ type: 'graph-update', nodes: nodes.length, edges: edges.length });

  console.log(`\x1b[35m[sim]\x1b[0m started: ${nodes.length} nodes, ${edges.length} edges, tick every ${intervalMs}ms`);

  const timer = setInterval(() => {
    simulateTick();
    writeFileSync(nodesFile, nodesCSV(), 'utf8');
    writeFileSync(edgesFile, edgesCSV(), 'utf8');
    broadcastFn({ type: 'graph-update', nodes: nodes.length, edges: edges.length });
    console.log(`\x1b[35m[sim]\x1b[0m tick ${tick}: ${nodes.length} nodes, ${edges.length} edges`);
  }, intervalMs);

  return { stop: () => clearInterval(timer) };
}
