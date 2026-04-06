# Graph Generation: Source Code to CSV Node/Edge Files

This document describes the realtime graph generation pipeline that produces `runtime/nodes.csv` and `runtime/edges.csv` from source code and codemap data.

## Overview

```
Source Code + Codemap  →  graphgen.mjs  →  nodes.csv + edges.csv  →  SSE push  →  Browser render
     ↑ fs.watch                                                          ↑ fs.watch
```

The server watches source and codemap files. When either changes, `graphgen.mjs` re-runs AST analysis and writes updated CSVs. The server detects CSV changes and pushes a `graph-update` event via SSE to all connected browsers, which re-fetch and re-render.

## CSV Formats (no headers)

### nodes.csv

One node per line: `id,type,cluster,importance,line`

| Field | Description |
|-------|-------------|
| id | Node identifier (function name, variable name, etc.) |
| type | `function` or `global` |
| cluster | Codemap section name this node belongs to (empty if unclustered) |
| importance | 1-10 importance score from codemap (default 3) |
| line | Source line number |

Example:
```
renderGraph,function,SVG Rendering,8,2007
currentNodes,global,,3,42
```

### edges.csv

One edge per line: `source,target,type,weight`

| Field | Description |
|-------|-------------|
| source | Source node id |
| target | Target node id |
| type | Edge type (see below) |
| weight | Numeric weight/strength |

Edge types:
- `calls` -- A calls B (directed, weight 3)
- `calledBy` -- A is called by B (directed, weight 3)
- `shared` -- A and B read/write the same globals (undirected, weight = count of shared globals)
- `sharedWrites` -- A and B both write the same globals (undirected, weight = count)
- `importance` -- both high-importance nodes sharing a structural link (undirected, weight = sqrt(impA * impB))
- `uses` -- function reads a global variable (directed, hypergraph)
- `writesTo` -- function writes to a global variable (directed, hypergraph)

## Usage

### Standalone

```bash
node codegen/graphgen.mjs                    # uses ./inspect.json
node codegen/graphgen.mjs path/to/inspect.json  # custom config
```

### Via server (automatic)

The server (`depgraph-server.mjs`) imports graphgen and:
1. Runs it on startup
2. Watches `src` and `codemap` files (from `inspect.json`)
3. Re-runs graphgen on any change (debounced 200ms)
4. Broadcasts `graph-update` SSE events to `/graph-events`

### As a library

```javascript
import { generate } from './codegen/graphgen.mjs';
const result = generate('./inspect.json');
// result: { nodesPath, edgesPath, nNodes, nEdges }
```

## Adding New Node/Edge Sources

The CSV files are the universal interface. Any tool can write to them:

1. Write `runtime/nodes.csv` and `runtime/edges.csv` in the formats above
2. The server's file watcher will detect the change and push updates to connected browsers

This means you can replace the AST analyzer with any other source -- a Python tool, a language server, a manual editor -- as long as the output CSV format is respected.

## Relationship to codegen.md

`codegen.md` documents the codemap generation process (source -> `depgraph.md`). This document covers the next step: codemap + source -> CSV node/edge files -> browser rendering. The codemap remains the primary clustering signal; the CSVs add the computed edges and node metadata that the browser previously derived via client-side AST analysis.

## Architecture

```
inspect.json
  ├── src: ./prototypes/index.html
  └── codemap: ./runtime/depgraph.md

graphgen.mjs reads both, then:
  1. extractJS()     -- pull <script> from HTML
  2. analyzeCode()   -- Acorn AST → {functions, globals} Maps
  3. parseCodemap()  -- markdown → {sections, importance}
  4. computeEdges()  -- pairwise edge computation (6 edge types)
  5. write CSVs      -- runtime/nodes.csv, runtime/edges.csv

Browser (index.html):
  1. Fetch /runtime/nodes.csv + /runtime/edges.csv
  2. buildAnalysisFromCSV() → compatibility shim for {functions, globals}
  3. Existing pipeline: clusterFunctions() → computeAffinities() → buildGraph() → render
  4. SSE /graph-events triggers re-fetch on changes
```
