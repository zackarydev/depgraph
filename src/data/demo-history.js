/**
 * Generate a dummy history for development/testing.
 *
 * Creates a realistic-looking graph with two clusters connected by
 * bridge nodes, plus a few isolated nodes. Good enough to test
 * the full pipeline without a codemap parser.
 *
 * @module data/demo-history
 */

/**
 * Generate demo history rows.
 * @returns {import('../core/types.js').HistoryRow[]}
 */
export function generateDemoHistory() {
  const rows = [];
  let t = 0;

  function addNode(id, kind, label, importance) {
    rows.push({ t: t++, type: 'NODE', op: 'add', id, kind, label, weight: importance || 1 });
  }

  function addEdge(source, target, layer, weight) {
    const id = `${source}\u2192${target}@${layer}`;
    rows.push({ t: t++, type: 'EDGE', op: 'add', id, source, target, layer, weight: weight || 1 });
  }

  // ─── Cluster A: "render" module (7 nodes) ───
  addNode('renderGraph', 'function', 'renderGraph', 5);
  addNode('renderNodes', 'function', 'renderNodes', 3);
  addNode('renderEdges', 'function', 'renderEdges', 3);
  addNode('renderHulls', 'function', 'renderHulls', 2);
  addNode('renderLabels', 'function', 'renderLabels', 2);
  addNode('computeHull', 'function', 'computeHull', 2);
  addNode('renderPositions', 'function', 'renderPositions', 4);

  addEdge('renderGraph', 'renderNodes', 'calls', 3);
  addEdge('renderGraph', 'renderEdges', 'calls', 3);
  addEdge('renderGraph', 'renderHulls', 'calls', 2);
  addEdge('renderGraph', 'renderLabels', 'calls', 2);
  addEdge('renderHulls', 'computeHull', 'calls', 2);
  addEdge('renderPositions', 'renderNodes', 'calls', 2);
  addEdge('renderPositions', 'renderEdges', 'calls', 2);
  addEdge('renderPositions', 'renderLabels', 'calls', 1);
  // intra-cluster shared state
  addEdge('renderNodes', 'renderEdges', 'shared', 1);
  addEdge('renderNodes', 'renderLabels', 'shared', 1);
  addEdge('renderHulls', 'renderLabels', 'shared', 1);

  // memberOf edges for cluster A
  addEdge('renderGraph', 'cluster:render', 'memberOf', 5);
  addEdge('renderNodes', 'cluster:render', 'memberOf', 5);
  addEdge('renderEdges', 'cluster:render', 'memberOf', 5);
  addEdge('renderHulls', 'cluster:render', 'memberOf', 5);
  addEdge('renderLabels', 'cluster:render', 'memberOf', 5);
  addEdge('computeHull', 'cluster:render', 'memberOf', 5);
  addEdge('renderPositions', 'cluster:render', 'memberOf', 5);

  // ─── Cluster B: "layout" module (6 nodes) ───
  addNode('descentStep', 'function', 'descentStep', 4);
  addNode('energy', 'function', 'energy', 3);
  addNode('initialPlace', 'function', 'initialPlace', 3);
  addNode('streamPlace', 'function', 'streamPlace', 2);
  addNode('warmRestart', 'function', 'warmRestart', 2);
  addNode('quadtree', 'function', 'quadtree', 3);

  addEdge('descentStep', 'energy', 'calls', 3);
  addEdge('descentStep', 'quadtree', 'calls', 2);
  addEdge('initialPlace', 'descentStep', 'calls', 3);
  addEdge('streamPlace', 'descentStep', 'calls', 2);
  addEdge('warmRestart', 'descentStep', 'calls', 2);
  addEdge('warmRestart', 'streamPlace', 'calls', 1);
  addEdge('energy', 'quadtree', 'calls', 2);
  addEdge('initialPlace', 'streamPlace', 'shared', 1);

  // memberOf edges for cluster B
  addEdge('descentStep', 'cluster:layout', 'memberOf', 5);
  addEdge('energy', 'cluster:layout', 'memberOf', 5);
  addEdge('initialPlace', 'cluster:layout', 'memberOf', 5);
  addEdge('streamPlace', 'cluster:layout', 'memberOf', 5);
  addEdge('warmRestart', 'cluster:layout', 'memberOf', 5);
  addEdge('quadtree', 'cluster:layout', 'memberOf', 5);

  // ─── Cluster C: "interact" module (5 nodes) ───
  addNode('selectNode', 'function', 'selectNode', 2);
  addNode('startDrag', 'function', 'startDrag', 3);
  addNode('startGather', 'function', 'startGather', 2);
  addNode('startTrace', 'function', 'startTrace', 3);
  addNode('keyDispatch', 'function', 'keyDispatch', 4);

  addEdge('keyDispatch', 'selectNode', 'calls', 2);
  addEdge('keyDispatch', 'startDrag', 'calls', 2);
  addEdge('keyDispatch', 'startGather', 'calls', 2);
  addEdge('keyDispatch', 'startTrace', 'calls', 2);
  addEdge('startDrag', 'selectNode', 'calls', 1);
  addEdge('startGather', 'selectNode', 'shared', 1);

  addEdge('selectNode', 'cluster:interact', 'memberOf', 5);
  addEdge('startDrag', 'cluster:interact', 'memberOf', 5);
  addEdge('startGather', 'cluster:interact', 'memberOf', 5);
  addEdge('startTrace', 'cluster:interact', 'memberOf', 5);
  addEdge('keyDispatch', 'cluster:interact', 'memberOf', 5);

  // ─── Bridge edges (cross-cluster) ───
  addEdge('renderPositions', 'descentStep', 'calls', 2);
  addEdge('renderGraph', 'initialPlace', 'calls', 1);
  addEdge('startDrag', 'renderPositions', 'calls', 1);
  addEdge('startTrace', 'renderNodes', 'calls', 1);
  addEdge('startGather', 'descentStep', 'calls', 1);

  // ─── A few isolated nodes ───
  addNode('createBus', 'function', 'createBus', 2);
  addNode('loadHistory', 'function', 'loadHistory', 3);
  addNode('parseCSV', 'function', 'parseCSV', 2);

  addEdge('loadHistory', 'parseCSV', 'calls', 3);
  addEdge('loadHistory', 'createBus', 'calls', 1);
  addEdge('renderGraph', 'loadHistory', 'calls', 1);

  // ─── Some globals for variety ───
  addNode('currentZoom', 'global', 'currentZoom', 1);
  addNode('nodePositions', 'global', 'nodePositions', 1);

  addEdge('renderPositions', 'nodePositions', 'writesTo', 2);
  addEdge('descentStep', 'nodePositions', 'writesTo', 2);
  addEdge('renderGraph', 'currentZoom', 'reads', 1);
  addEdge('renderNodes', 'currentZoom', 'reads', 1);

  return rows;
}
