/**
 * Phase 10f handler: image files.
 *
 * Each image becomes a NODE kind=image whose payload carries the relative
 * path. The renderer can use that path to draw the image at the node's
 * position (foreignObject / image element), making the picture itself the
 * node — exactly the user's vision.
 *
 * @module codegen/handlers/image
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';

export const extensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'];

export function handle(absPath, relPath) {
  let size = 0;
  try { size = statSync(absPath).size; } catch {}
  const fileId = `file:${relPath}`;
  return {
    nodes: [{
      id: fileId,
      kind: 'image',
      label: basename(relPath),
      payload: { path: relPath, src: relPath, bytes: size },
    }],
    edges: [],
  };
}
