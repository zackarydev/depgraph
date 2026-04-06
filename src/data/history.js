/**
 * Unified history log: cursor, replay, branches, append.
 * @module data/history
 */

export function createHistory() {}

export function load(csvString) {}

export function append(history, row) {}

export function moveCursor(history, position) {}

export function branch(history, atCursor) {}

export function switchBranch(history, branchId) {}

export function branches(history) {}
