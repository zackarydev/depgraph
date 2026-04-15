/**
 * Phase 10f handler: JavaScript / .mjs / .cjs files.
 *
 * Wraps codegen/ast.mjs but is callable from the repo scanner. It returns
 * untimestamped {nodes, edges} so the scanner can dedupe + assign t.
 *
 * @module codegen/handlers/js
 */

import { readFileSync } from 'node:fs';
import { parseJS } from '../ast.mjs';

export const extensions = ['.js', '.mjs', '.cjs'];

/**
 * @param {string} absPath - absolute file path
 * @param {string} relPath - path relative to repo root (used as id basis)
 * @returns {{nodes:Array,edges:Array}}
 */
export function handle(absPath, relPath) {
  const source = readFileSync(absPath, 'utf-8');
  const fileId = `file:${relPath}`;
  return parseJS(source, { filePath: relPath, fileId });
}
