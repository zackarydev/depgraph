/**
 * Unified history log: the single source of truth.
 *
 * History is an append-only event log of NODE and EDGE rows.
 * A cursor points to the current position; the derived graph state
 * equals replay(history[0..cursor]).
 *
 * Branches are created when the user appends at a cursor that is not
 * at the end of the current branch. The old tail becomes a sibling branch.
 *
 * See SPEC.md §4 (External Data Contract) and §10-11 (Time Travel / Streaming).
 *
 * @module data/history
 */

import { parseCSV, writeCSV } from './csv.js';
import { createState, applyRow, replayRows } from '../core/state.js';

/**
 * @typedef {Object} Branch
 * @property {string} id
 * @property {string} parentId - parent branch id (null for main)
 * @property {number} forkCursor - the cursor position at which this branch forked
 * @property {import('../core/types.js').HistoryRow[]} rows - rows in this branch (after fork point)
 */

/**
 * @typedef {Object} History
 * @property {import('../core/types.js').HistoryRow[]} rows - main trunk of rows
 * @property {number} cursor - current position (index into effective row list)
 * @property {string} activeBranch - id of the active branch ('main' for trunk)
 * @property {Map<string, Branch>} branches
 * @property {number} nextT - next monotonic timestamp to assign
 * @property {import('../core/state.js').State} state - derived state at cursor
 */

let branchCounter = 0;

/**
 * Create an empty history.
 * @returns {History}
 */
export function createHistory() {
  return {
    rows: [],
    cursor: -1,
    activeBranch: 'main',
    branches: new Map(),
    nextT: 0,
    state: createState(),
  };
}

/**
 * Load history from a CSV string.
 * Replays all rows and sets cursor to the end.
 *
 * @param {string} csvString
 * @returns {History}
 */
export function load(csvString) {
  const rows = parseCSV(csvString);
  const history = createHistory();
  history.rows = rows;

  // set nextT to max(t) + 1
  if (rows.length > 0) {
    history.nextT = Math.max(...rows.map(r => r.t)) + 1;
  }

  // replay all rows to build state, set cursor to end
  history.state = replayRows(rows);
  history.cursor = rows.length - 1;

  return history;
}

/**
 * Export history to a CSV string.
 * @param {History} history
 * @returns {string}
 */
export function toCSV(history) {
  return writeCSV(history.rows);
}

/**
 * Get the effective row list for the active branch.
 * Main branch = history.rows.
 * Other branch = history.rows[0..forkCursor] + branch.rows.
 *
 * @param {History} history
 * @returns {import('../core/types.js').HistoryRow[]}
 */
export function effectiveRows(history) {
  if (history.activeBranch === 'main') {
    return history.rows;
  }
  const branch = history.branches.get(history.activeBranch);
  if (!branch) return history.rows;

  // trunk rows up to (and including) the fork point + branch rows
  const trunkSlice = history.rows.slice(0, branch.forkCursor + 1);
  return trunkSlice.concat(branch.rows);
}

/**
 * Rebuild state by replaying effective rows up to cursor.
 * @param {History} history
 */
function rebuildState(history) {
  const rows = effectiveRows(history);
  const toReplay = rows.slice(0, history.cursor + 1);
  history.state = replayRows(toReplay);
}

/**
 * Append a row to history. Assigns a monotonic timestamp.
 *
 * If cursor is not at the end of the current branch, a new branch is
 * created from the current cursor position, and the row is appended there.
 *
 * @param {History} history
 * @param {Partial<import('../core/types.js').HistoryRow>} row - t will be assigned
 * @returns {import('../core/types.js').HistoryRow} the row as appended (with t assigned)
 */
export function append(history, row) {
  const fullRow = { ...row, t: history.nextT++ };
  const eff = effectiveRows(history);

  // if cursor is not at the end, we need to branch
  if (history.cursor < eff.length - 1) {
    // create a branch for the old tail (if on main and tail hasn't been branched yet)
    if (history.activeBranch === 'main') {
      const tailRows = history.rows.slice(history.cursor + 1);
      if (tailRows.length > 0) {
        const tailBranch = {
          id: `branch-${++branchCounter}`,
          parentId: 'main',
          forkCursor: history.cursor,
          rows: tailRows,
        };
        history.branches.set(tailBranch.id, tailBranch);
      }
      // truncate main to cursor position
      history.rows.length = history.cursor + 1;
    } else {
      // on a branch already — truncate the branch rows
      const branch = history.branches.get(history.activeBranch);
      const branchIndex = history.cursor - branch.forkCursor;
      if (branchIndex >= 0) {
        const tailRows = branch.rows.slice(branchIndex);
        if (tailRows.length > 0) {
          const tailBranch = {
            id: `branch-${++branchCounter}`,
            parentId: history.activeBranch,
            forkCursor: history.cursor,
            rows: tailRows,
          };
          history.branches.set(tailBranch.id, tailBranch);
        }
        branch.rows.length = branchIndex;
      }
    }
  }

  // append the row
  if (history.activeBranch === 'main') {
    history.rows.push(fullRow);
  } else {
    const branch = history.branches.get(history.activeBranch);
    branch.rows.push(fullRow);
  }

  // advance cursor and apply row to state
  history.cursor++;
  applyRow(history.state, fullRow);

  return fullRow;
}

/**
 * Splice rows into the active branch immediately after the cursor, without
 * forking the tail. Each row gets a fresh monotonic `t`. Rows past the
 * cursor stay in place and continue to play when the cursor advances.
 *
 * Use case: scrub back to a position, splice in a positions snapshot or a
 * gradient-descent result, then continue forward through the original tail
 * with the new state in effect.
 *
 * Note: in-memory only — does not mirror to any persistence channel.
 *
 * @param {History} history
 * @param {Partial<import('../core/types.js').HistoryRow>[]} partials
 * @returns {import('../core/types.js').HistoryRow[]} rows as inserted (with t)
 */
export function insertRows(history, partials) {
  if (!partials || partials.length === 0) return [];
  const inserted = [];
  for (const partial of partials) {
    const fullRow = { ...partial, t: history.nextT++ };
    const insertIdx = history.cursor + 1;

    if (history.activeBranch === 'main') {
      history.rows.splice(insertIdx, 0, fullRow);
    } else {
      const branch = history.branches.get(history.activeBranch);
      if (!branch) continue;
      const branchIdx = insertIdx - branch.forkCursor - 1;
      branch.rows.splice(branchIdx, 0, fullRow);
    }

    history.cursor++;
    applyRow(history.state, fullRow);
    inserted.push(fullRow);
  }
  return inserted;
}

/**
 * Move the cursor to an absolute position.
 * Rebuilds state by replaying rows[0..position].
 *
 * @param {History} history
 * @param {number} position - index (0-based) into effective rows
 * @returns {number} the new cursor position (clamped)
 */
export function moveCursor(history, position) {
  const eff = effectiveRows(history);
  const maxPos = eff.length - 1;
  const newPos = Math.max(-1, Math.min(position, maxPos));

  if (newPos === history.cursor) return newPos;

  history.cursor = newPos;
  rebuildState(history);

  return history.cursor;
}

/**
 * Step cursor by a delta (positive = forward, negative = backward).
 * @param {History} history
 * @param {number} delta
 * @returns {number} new cursor position
 */
export function stepCursor(history, delta) {
  return moveCursor(history, history.cursor + delta);
}

/**
 * Switch to a different branch.
 * The cursor moves to the end of the target branch.
 *
 * @param {History} history
 * @param {string} branchId - 'main' or a branch id
 * @returns {boolean} true if switched, false if branch not found
 */
export function switchBranch(history, branchId) {
  if (branchId === 'main') {
    history.activeBranch = 'main';
    history.cursor = history.rows.length - 1;
    rebuildState(history);
    return true;
  }

  const branch = history.branches.get(branchId);
  if (!branch) return false;

  history.activeBranch = branchId;
  const eff = effectiveRows(history);
  history.cursor = eff.length - 1;
  rebuildState(history);
  return true;
}

/**
 * Get the list of all branches (including main).
 * @param {History} history
 * @returns {{ id: string, parentId: string|null, forkCursor: number, length: number }[]}
 */
export function listBranches(history) {
  const result = [
    { id: 'main', parentId: null, forkCursor: 0, length: history.rows.length },
  ];
  for (const [, branch] of history.branches) {
    result.push({
      id: branch.id,
      parentId: branch.parentId,
      forkCursor: branch.forkCursor,
      length: branch.forkCursor + 1 + branch.rows.length,
    });
  }
  return result;
}

/**
 * Get the total number of rows in the effective branch.
 * @param {History} history
 * @returns {number}
 */
export function length(history) {
  return effectiveRows(history).length;
}
