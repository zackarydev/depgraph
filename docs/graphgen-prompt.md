Design an implementation plan for adding realtime graph updates to the depgraph project via external CSV files.

## Current Architecture

The depgraph project is a dependency graph visualizer. Here's the current data flow:

```
Source Code (HTML) → extractJS() → analyzeCode() via Acorn AST → {functions: Map, globals: Map}
  → clusterFunctions() + computeAffinities() → buildGraph() → computeLayout() → renderGraph() (D3 SVG)
```

Key files:
- `/Users/zack/Documents/depgraph/prototypes/index.html` (~4744 lines) — entire frontend app
- `/Users/zack/Documents/depgraph/depgraph-server.mjs` (258 lines) — Node.js HTTP server + SSE
- `/Users/zack/Documents/depgraph/codegen/codemap.py` (246 lines) — Python codemap generator
- `/Users/zack/Documents/depgraph/runtime/depgraph.md` — codemap (clusters of functions)
- `/Users/zack/Documents/depgraph/codegen/codegen.md` — documentation of the codegen process
- `/Users/zack/Documents/depgraph/inspect.json` — project config

## What the user wants

1. **External CSV files**: Move node and edge data to `runtime/nodes.csv` and `runtime/edges.csv` (no CSV headers)
2. **File watchers in Node.js server**: Watch for changes in `src` and `codemap` files. When those change, recompute `runtime/nodes.csv` and `runtime/edges.csv`.
3. **Realtime push to frontend**: The server should push updates to the frontend when CSV files change (SSE already exists for focus events).
4. **Design document**: Create documentation alongside codegen.md.

## Coupling Analysis — How tangled is the code to "functions"/"vars"/"globals"?

HEAVILY tangled. Here are the coupling points:

### AST Analysis (index.html lines 750-792)
- `analyzeCode()` returns `{ globals: Map<name, {kind, line}>, functions: Map<name, {reads, writes, rw, calls, params, locals, line, endLine, lines}> }`
- `analyzeFunction()` (lines 806-877) walks function bodies for reads/writes/calls

### Edge Layers (index.html lines 1091-1211)
Six hardcoded edge layers, all assuming function properties:
- `calls`: uses `a.calls.has(nameB)` 
- `calledBy`: reverse of calls
- `shared`: uses `a.reads`, `a.writes`, `a.rw` Sets
- `sharedWrites`: uses `a.writes`, `a.rw` Sets
- `importance`: uses `a.calls` + reads/writes/rw
- `uses`/`writesTo`: created directly in buildGraph for hypergraph mode

### buildGraph() (index.html lines 1387-1507)
- Creates function nodes from `analysis.functions` with `type: 'function'`
- Creates global nodes in hypergraph mode with `type: 'global'`
- Iterates `functions.keys()` for pairwise edge computation

### Clustering (index.html lines 928-980)
- `clusterFunctions()` maps function names to cluster IDs from codemap sections

### Affinities (index.html lines 1020-1081)
- Iterates `info.reads`, `info.writes`, `info.rw`, `info.calls` for affinity weights

### Main Loop (index.html lines 4662-4690)
- `loadAndAnalyze()` fetches HTML source, extracts JS, runs AST analysis
- Polls on interval, checks hash to detect changes

### Server (depgraph-server.mjs)
- Already has SSE via `/focus-events` endpoint (lines 198-210)
- Already watches `runtime/depgraph-focus.json` (lines 44-61)
- Serves `/target/src` (source file) and codemap

## Design Requirements

1. CSV format for nodes.csv and edges.csv (no headers)
2. Server watches `src` and `codemap` files, regenerates CSVs when they change
3. Server watches CSVs and pushes updates to frontend via SSE
4. Frontend can consume CSV data as an alternative to (or replacement for) AST analysis
5. The user is curious about how much refactoring is needed given the tight coupling

## Key Questions to Address in the Plan

1. **CSV format**: What columns for nodes.csv and edges.csv?
2. **Who computes edges?**: AST analysis currently happens in the BROWSER (Acorn is loaded client-side), it must be moved to NodeJS and it must generate nodes/edges. CSVs can be populated by many different sources.
   - Many tools should be able to push nodes and edges, similar to how codegen.py does it.
   - Browser no longer does AST analysis but only combines and reads the nodes/edges.
3. **Decoupling strategy**: How to make buildGraph() work with CSV data vs AST data, maybe buildGraph should just be its own process/thing?
4. **What gets into the CSVs vs stays computed client-side**: Clustering and affinities are currently computed from the codemap + AST together. Where does that boundary move?

Please design a detailed implementation plan covering:
- CSV file formats
- Server-side changes (file watching, SSE, CSV regeneration)
- Frontend changes (CSV consumption, decoupling from AST)
- The decoupling strategy for function/var/global concepts
- Phase/ordering of implementation steps
- What to document