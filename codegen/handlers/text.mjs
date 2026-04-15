/**
 * Phase 10f handler: fallback for any file we don't have a richer handler for.
 *
 * Emits a single NODE kind=file. No expansion. This guarantees every file in
 * the repo appears in the hypergraph, even if we can't parse it.
 *
 * @module codegen/handlers/text
 */

import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';

// No `extensions` export — this handler is the catch-all default.
export const isFallback = true;

export function handle(absPath, relPath) {
  let size = 0;
  try { size = statSync(absPath).size; } catch {}
  const fileId = `file:${relPath}`;
  return {
    nodes: [{
      id: fileId,
      kind: 'file',
      label: basename(relPath),
      payload: { path: relPath, bytes: size, ext: extname(relPath) },
    }],
    edges: [],
  };
}
