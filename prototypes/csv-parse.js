// ── CSV parsing (shared) ─────────────────────────────────────────────────
//
// Two pure functions used by multiple modules:
//
//   parseCSVLine(line) → string[]
//       Minimal RFC-4180-ish parser: handles quoted fields with embedded
//       commas and doubled quotes. Does NOT handle embedded newlines.
//
//   parseHistoryCSV(text) → { nodes, edges }
//       Interprets the depgraph `history.csv` format:
//           t,type,label,source,target,importance_xi,cluster
//       Produces a graph with named node ids (resolving the numeric
//       source/target indices via the NODE rows). Cluster-defining rows
//       (idx === cluster column) become nodes of type 'cluster'.
//
// Zero DOM, zero fetch — safe for Node tests.
(function (root) {
  'use strict';

  function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else current += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { fields.push(current); current = ''; }
        else current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  function parseHistoryCSV(text) {
    const nodes = [];
    const edges = [];
    const idxToName = new Map();
    const clusterIdxToName = new Map();
    const clusterNodeNames = new Set();

    const lines = text.trim().split('\n');
    for (let i = 1; i < lines.length; i++) { // skip header
      const line = lines[i];
      if (!line) continue;
      const fields = parseCSVLine(line);
      const rowType = fields[1];

      if (rowType === 'NODE') {
        const name = fields[2];
        const idx = parseInt(fields[3]);
        const importanceXi = parseFloat(fields[5]) || 0;
        const clusterCol = fields[6];
        const importance = importanceXi * 10;

        idxToName.set(idx, name);

        if (clusterCol !== '' && clusterCol !== undefined) {
          const cn = parseInt(clusterCol);
          if (!isNaN(cn) && cn === idx) {
            clusterIdxToName.set(cn, name);
            clusterNodeNames.add(name);
            nodes.push({ id: name, type: 'cluster', cluster: '', importance, line: 0 });
            continue;
          }
        }

        let clusterName = '';
        if (clusterCol !== '' && clusterCol !== undefined) {
          const cn = parseInt(clusterCol);
          if (!isNaN(cn) && clusterIdxToName.has(cn)) {
            clusterName = clusterIdxToName.get(cn);
          }
        }

        // Column 4 (target) carries the node type for enriched CSVs;
        // fall back to importance heuristic.
        const csvType = fields[4];
        const nodeType = csvType && csvType !== '' ? csvType : (importanceXi <= 0.1 ? 'global' : 'function');
        nodes.push({ id: name, type: nodeType, cluster: clusterName, importance, line: 0 });

      } else if (rowType === 'EDGE') {
        const srcIdx = parseInt(fields[3]);
        const tgtIdx = parseInt(fields[4]);
        const srcName = idxToName.get(srcIdx);
        const tgtName = idxToName.get(tgtIdx);
        const label = fields[2];

        if (srcName && tgtName) {
          if (label === 'memberOf') {
            const srcNode = nodes.find(n => n.id === srcName);
            if (srcNode) srcNode.cluster = tgtName;
          } else if (!clusterNodeNames.has(srcName) && !clusterNodeNames.has(tgtName)) {
            edges.push({ source: srcName, target: tgtName, type: label, weight: 1 });
          }
        }
      }
    }
    return { nodes, edges };
  }

  const api = { parseCSVLine, parseHistoryCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.csvParse = api;
})(typeof window !== 'undefined' ? window : null);
