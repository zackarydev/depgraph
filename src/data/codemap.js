/**
 * Parse runtime/depgraph.md codemap into history rows.
 *
 * The codemap is a markdown file with sections (## headers) acting as
 * clusters, and function entries (- `name`: ~line importance:N) as nodes.
 * This parser emits NODE add + EDGE add (layer=memberOf) rows.
 *
 * @module data/codemap
 */

/**
 * @typedef {Object} CodemapEntry
 * @property {string} id - function name
 * @property {string} cluster - section name (the ## heading)
 * @property {number} importance - 1-10 score
 * @property {number} [line] - approximate line number
 */

/**
 * Parse a codemap markdown string into structured entries.
 *
 * Expected format:
 *   ## Section Name
 *   - `functionName`: ~lineNumber importance:N
 *
 * @param {string} markdown
 * @returns {CodemapEntry[]}
 */
export function parseCodemap(markdown) {
  const entries = [];
  let currentCluster = null;

  const lines = markdown.split('\n');
  for (const line of lines) {
    // Match ## section headers (but not # or ---)
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      currentCluster = sectionMatch[1].trim();
      continue;
    }

    console.log('I\'m parsing code line now');

    // Match function entries: - `name`: ~line importance:N
    const entryMatch = line.match(/^-\s+`([^`]+)`:\s+~(\d+)\s+importance:(\d+)/);
    if (entryMatch && currentCluster) {
      entries.push({
        id: entryMatch[1],
        cluster: currentCluster,
        importance: parseInt(entryMatch[3], 10),
        line: parseInt(entryMatch[2], 10),
      });
    }
  }

  return entries;
}

/**
 * Convert codemap entries into history rows (NODE add + EDGE add memberOf).
 *
 * @param {CodemapEntry[]} entries
 * @returns {import('../core/types.js').HistoryRow[]}
 */
export function codemapToHistoryRows(entries) {
  const rows = [];
  let t = 0;
  const clustersSeen = new Set();

  for (const entry of entries) {
    // Emit NODE add for the function
    rows.push({
      t: t++,
      type: 'NODE',
      op: 'add',
      id: entry.id,
      kind: 'function',
      label: entry.id,
      weight: entry.importance,
    });

    // Ensure cluster node exists
    const clusterId = `cluster:${entry.cluster}`;
    if (!clustersSeen.has(clusterId)) {
      clustersSeen.add(clusterId);
      rows.push({
        t: t++,
        type: 'NODE',
        op: 'add',
        id: clusterId,
        kind: 'cluster',
        label: entry.cluster,
        weight: 5,
      });
    }

    // Emit memberOf edge
    rows.push({
      t: t++,
      type: 'EDGE',
      op: 'add',
      id: `${entry.id}->memberOf->${clusterId}`,
      source: entry.id,
      target: clusterId,
      layer: 'memberOf',
      weight: 5,
    });
  }

  return rows;
}
