# Codegen Process: Source Code to Dependency Graph

This document describes the process of generating `runtime/depgraph.md` (or `runtime/project_codemap.md`) from source code. The codemap is the input that drives the depgraph visualizer.

## Overview

```
Source Code  →  AST Parse  →  Extract Nodes  →  Cluster Assignment  →  depgraph.md
```

The goal is to turn raw source files into a structured codemap where every function and variable is a node in a hypergraph, grouped into conceptual clusters.

## Step-by-step Process

### 1. Read the Source Code

Identify all source files in the project. For depgraph itself:
- `prototypes/index.html` — main application (JS embedded in HTML)
- `depgraph-server.mjs` — Node.js server
- `codegen/codemap.py` — Python code analysis tool

### 2. AST Parsing

Parse each source file into an Abstract Syntax Tree to extract structured information.

**For JavaScript (in index.html):**
- The app uses [Acorn](https://github.com/acornjs/acorn) to parse JS from `<script>` tags
- `extractJS()` pulls the JS block and computes a `lineOffset` so line numbers map back to the HTML file
- `analyzeCode()` walks the AST in two passes:
  - **Pass 1**: Collect all top-level declarations (variables, functions) into a `globals` map
  - **Pass 2**: For each function, call `analyzeFunction()` which walks the function body to find:
    - `reads` — global variables read
    - `writes` — global variables written
    - `rw` — globals both read and written
    - `calls` — other top-level functions called

**For Python (codemap.py):**
- `extract_functions()` uses regex to find `function name(` patterns
- `extract_constants()` finds `const/let ALL_CAPS_NAME =` patterns

**For Node.js (depgraph-server.mjs):**
- Same regex/AST approach; functions declared with `function name()` become nodes

### 3. Each Variable/Function Becomes a Node

After AST analysis, every named entity becomes a node:
- **Function nodes**: Each `function name()` declaration
- **Global variable nodes** (in hypergraph mode): Each top-level `const/let/var` that is used by 2+ functions

Each node carries metadata:
- Name (identifier)
- Line number in source
- Type (`function` or `global`)
- Dependencies: reads, writes, calls, called-by

### 4. Claude Reads the AST and Creates Conceptual Clusters

This is the human/AI step. Claude (or a human) reads through all extracted functions and groups them into **conceptual clusters** — high-level systems or feature areas.

**Clustering criteria:**
- **Functional cohesion**: Functions that work together on the same feature
- **Shared state**: Functions that read/write the same globals
- **Call relationships**: Functions that call each other frequently
- **Naming patterns**: Functions with related name tokens (e.g., `startAttractor`, `attractorLoop`, `lockAttractor`)
- **Conceptual domain**: Functions belonging to the same abstraction layer

**For depgraph, the clusters are:**

| Cluster | What it covers |
|---------|---------------|
| AST Analysis | Parsing source code into structured data |
| Codemap Parsing | Reading the markdown codemap format |
| Clustering & Affinities | Assigning functions to systems, computing affinity scores |
| Graph Building | Converting analysis results into nodes + edges |
| Layout Engine | Force-directed positioning, cluster packing |
| Animation | Smooth transitions between positions |
| SVG Rendering | D3-based drawing of nodes, edges, hulls, labels |
| Cluster Labels & Meta-edges | Inter-cluster visualization layer |
| Spatial Memory | Persisting user arrangements in localStorage |
| Arrangement Navigation | Time-travel through layout history |
| Node Interaction | Selection, highlighting, info panel |
| Attractor / Gravity Well | Force-touch pull mechanic |
| Gather & Pull | Space-pull, neighbor-gather, cluster-gather |
| Spread & Dismiss | X-key spread, right-click repulse, dismiss to T0 |
| Time Travel | Z-key hold to scrub backwards |
| Lock / Selection | Pin/unpin nodes |
| User Clusters | Create/delete custom groupings via Enter key |
| Main Loop | Load, parse, rebuild cycle + SSE focus events |
| Server | HTTP static serving + SSE broadcast |
| Code Analysis Tool | Python codemap generator |

### 5. Write the Codemap

The output is written to `runtime/depgraph.md` in this format:

```markdown
---
name: Code Map
description: ...
type: reference
---

## Cluster Name
- `functionName`: ~lineNumber importance:N
- `anotherFunc`: ~lineNumber importance:N

## Another Cluster
- `func`: ~lineNumber importance:N
```

**Format rules:**
- YAML frontmatter with name, description, type
- Each cluster is an `## H2` heading
- Each function is a list item: `` - `name`: ~line importance:N ``
- Importance is 1-10 (manually curated, default 3)
- Line numbers are approximate (`~`) since they may shift between edits
- User-created clusters include a `<!-- user-cluster -->` marker after the heading

### 6. How the Visualizer Consumes the Codemap

The depgraph visualizer (`prototypes/index.html`) reads the codemap and uses it as the **primary clustering signal**:

1. `parseCodemap()` reads the markdown, extracts sections and function lists
2. `clusterFunctions()` assigns each function to its codemap section (weight 5.0 — strongest signal)
3. `computeAffinities()` adds 4 secondary signals:
   - Name token matching (weight 1.5)
   - Global reads/writes (weight 0.5)
   - Function calls (weight 0.3)
   - Called-by relationships (weight 0.2)
4. Functions can have partial affinity to multiple clusters (shown as secondary color rings)
5. The layout engine positions nodes within clusters, then packs clusters to avoid overlap

## Automated vs. Manual

| Step | Automated | Manual/AI |
|------|-----------|-----------|
| AST parsing | `codemap.py` or Acorn | — |
| Node extraction | `codemap.py` or `analyzeCode()` | — |
| Cluster creation | — | Claude reads functions, creates conceptual groups |
| Cluster naming | — | Claude names each group |
| Importance scoring | Default 3 | Human tunes 1-10 per function |
| Codemap writing | `codemap.py --update` (Equinox) | Claude writes markdown (depgraph) |
| Affinity scoring | `computeAffinities()` | — |
| Layout & rendering | `computeLayout()` + D3 | — |

The codemap is the **bridge** between automated AST analysis and human/AI understanding. It encodes the "why" (conceptual grouping) that pure syntax analysis cannot infer.
