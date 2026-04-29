active layer: L1 (PageUp/PageDown to step · Infinity = show all)

# Fractal Layers

- nodes: 24
- clusters: 7 (cluster-targets: 7)
- max level: 3
- roots: 1 (orphan leaves at root: 1)

## Counts per level
- L0: 1
- L1: 19
- L2: 3
- L3: 1

## Tree
· mouse-clicked  (L0 · sentinel)

## Hyperedges
- total: 56 across 5 layer(s)

### layer: calls  (21 hyperedges)
  L1:
    · descentStep  ×7
    · renderGraph  ×6
    · renderPositions  ×5
    · keyDispatch  ×4
    · renderNodes  ×3
    · startDrag  ×3
    · renderEdges  ×2
    · renderHulls  ×2
    · renderLabels  ×2
    · energy  ×2
    · quadtree  ×2
    · initialPlace  ×2
    · streamPlace  ×2
    · warmRestart  ×2
    · selectNode  ×2
    · startGather  ×2
    · startTrace  ×2
    · computeHull  ×1
    · parseCSV  ×1
  L2:
    · loadHistory  ×3
  L3:
    · createBus  ×1

### layer: memberOf  (21 hyperedges)
  L0:
    · cluster:render  ×7
    · cluster:layout  ×6
    · cluster:interact  ×5
  L1:
    · renderGraph  ×1
    · renderNodes  ×1
    · renderEdges  ×1
    · renderHulls  ×1
    · renderLabels  ×1
    · computeHull  ×1
    · renderPositions  ×1
    · descentStep  ×1
    · energy  ×1
    · initialPlace  ×1
    · streamPlace  ×1
    · warmRestart  ×1
    · quadtree  ×1
    · selectNode  ×1
    · startDrag  ×1
    · startGather  ×1
    · startTrace  ×1
    · keyDispatch  ×1

### layer: reads  (3 hyperedges)
  L1:
    · renderGraph  ×1
    · renderNodes  ×1
  L2:
    · currentZoom  ×2

### layer: shared  (8 hyperedges)
  L1:
    · renderNodes  ×2
    · renderLabels  ×2
    · renderEdges  ×1
    · renderHulls  ×1
    · initialPlace  ×1
    · streamPlace  ×1
    · startGather  ×1
    · selectNode  ×1

### layer: writesTo  (3 hyperedges)
  L1:
    · renderPositions  ×1
    · descentStep  ×1
  L2:
    · nodePositions  ×2