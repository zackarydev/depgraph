# Plan: Prototype Code Review & Refactoring Analysis

## Context
The depgraph prototype has grown to ~7600 lines in a single `index.html` file (290KB). It needs a comprehensive review to identify duplicate functionality, bugs from shared state, tangled concerns, and a path toward clean separation -- particularly isolating the hypergraph data model from rendering, physics, interaction, and navigation.

## What Was Done
Created `/Users/zack/Documents/depgraph/prototypes/REVIEW.md` -- a comprehensive markdown document structured as a parseable graph (## = clusters, - `id`: = nodes, backtick cross-refs = edges).

## Document Contents

### Functional inventory (11 clusters)
- Data Pipeline (parsing, clustering, graph construction)
- Edge Layer System (config, visibility, zoom breakpoints)
- Layout & Physics (initial layout, GraphPhysics, StreamPlacement, position persistence)
- SVG Rendering (layers, semantic zoom, node rendering, position updates)
- Cluster Visuals (hulls, meta-edges, labels, importance)
- Interaction (selection, attractor, x-relax, z-travel, t-trace, gather)
- Event Handling (keyboard dispatch, mouse/touch)
- Streaming & Live Reload (SSE, cinematic mode)
- Spatial Memory (arrangements, time-travel)

### Navigation vs Zoom analysis
- Table mapping each zoom-dependent behavior to "optical" vs "navigation"
- Identified that `applySemanticZoom` is the key tangled function
- Proposed: navigation levels should be discrete operations independent of camera zoom

### Anomalies section
- 7 specific bugs (timer leaks, stale state, undefined constants, race conditions)
- 8 duplicate functionality pairs with line numbers
- Parallel state drift analysis (savedPositions/stickyNodes/lockedNodes)
- 13+ uncoordinated RAF loops

### Node-Cluster duality analysis
- Current model: clusters are implicit (just a property on nodes)
- Missing: expand/collapse topology changes, cluster-as-node representation
- Recommended: recursive containment structure

### Hypergraph concept isolation
- What makes it a hypergraph (N-ary relations, typed layers, multi-membership, projections)
- What needs isolation from rendering, physics, interaction, navigation, persistence

### Recommended file split
- 30 files organized by responsibility
- 5 key architectural changes: central animation scheduler, unified visibility, unified position persistence, unified cluster centroid, navigation separated from rendering

## Verification
- Open `prototypes/REVIEW.md` and verify all line number references against `index.html`
- Cross-reference duplicate functionality claims by reading both code locations
- Use REVIEW.md as input to a future refactoring implementation
