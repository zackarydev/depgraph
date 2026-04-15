/**
 * Phase 10f handler: Markdown files.
 *
 * The file becomes a NODE kind=markdown-file. Each `#`/`##`/`###` heading
 * becomes a child NODE kind=heading with a memberOf edge back to the file.
 * Sibling headings at the same depth are linked by `next` edges so an agent
 * can walk the document order.
 *
 * @module codegen/handlers/markdown
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const extensions = ['.md', '.markdown'];

export function handle(absPath, relPath) {
  const source = readFileSync(absPath, 'utf-8');
  const fileId = `file:${relPath}`;
  const nodes = [{
    id: fileId,
    kind: 'markdown-file',
    label: basename(relPath),
    payload: { path: relPath, lines: source.split('\n').length },
  }];
  const edges = [];

  const headings = [];
  const lines = source.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^```/.test(ln)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = ln.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    const depth = m[1].length;
    const title = m[2];
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = `${fileId}#h${depth}:${slug}`;
    headings.push({ id, depth, line: i + 1, title });
    nodes.push({
      id,
      kind: 'heading',
      label: title,
      payload: { file: relPath, line: i + 1, depth },
    });
    edges.push({
      id: `${id}->memberOf->${fileId}`,
      source: id,
      target: fileId,
      layer: 'memberOf',
      weight: 4,
    });
  }

  // Link consecutive same-depth headings with a `next` edge.
  for (let i = 0; i < headings.length; i++) {
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].depth < headings[i].depth) break;
      if (headings[j].depth === headings[i].depth) {
        edges.push({
          id: `${headings[i].id}->next->${headings[j].id}`,
          source: headings[i].id,
          target: headings[j].id,
          layer: 'next',
          weight: 1,
        });
        break;
      }
    }
  }
  return { nodes, edges };
}
