/**
 * Phase 10f handler: JSON files.
 *
 * The whole file becomes a NODE kind=json-file. A few well-known shapes get
 * expanded into child nodes:
 *
 *   package.json           → each entry under `scripts` becomes a NODE kind=script,
 *                            each dep under `dependencies`/`devDependencies` becomes
 *                            NODE kind=dependency
 *   inspect.json           → fields become NODE kind=config-field
 *   *.json                 → top-level keys become NODE kind=json-key
 *
 * Expansion is shallow on purpose; deeper drill-down is the next phase.
 *
 * @module codegen/handlers/json
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const extensions = ['.json'];

export function handle(absPath, relPath) {
  const source = readFileSync(absPath, 'utf-8');
  const fileId = `file:${relPath}`;
  const nodes = [];
  const edges = [];

  let parsed = null;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    nodes.push({
      id: fileId,
      kind: 'json-file',
      label: basename(relPath),
      payload: { path: relPath, parseError: err.message },
    });
    return { nodes, edges };
  }

  nodes.push({
    id: fileId,
    kind: 'json-file',
    label: basename(relPath),
    payload: { path: relPath, lines: source.split('\n').length },
  });

  const isPkg = basename(relPath) === 'package.json';

  if (isPkg && parsed && typeof parsed === 'object') {
    if (parsed.scripts && typeof parsed.scripts === 'object') {
      for (const [name, body] of Object.entries(parsed.scripts)) {
        const id = `${fileId}#script:${name}`;
        nodes.push({
          id,
          kind: 'script',
          label: name,
          payload: { command: body, file: relPath },
        });
        edges.push({
          id: `${id}->memberOf->${fileId}`,
          source: id,
          target: fileId,
          layer: 'memberOf',
          weight: 5,
        });
      }
    }
    for (const depKey of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = parsed[depKey];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, version] of Object.entries(deps)) {
        const id = `dep:${name}`;
        nodes.push({
          id,
          kind: 'dependency',
          label: name,
          payload: { version, source: depKey },
        });
        edges.push({
          id: `${fileId}->depends->${id}`,
          source: fileId,
          target: id,
          layer: 'depends',
          weight: 1,
        });
      }
    }
    return { nodes, edges };
  }

  // Generic JSON: expose top-level keys as child nodes.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      const id = `${fileId}#${key}`;
      nodes.push({
        id,
        kind: 'json-key',
        label: key,
        payload: { type: typeof value, file: relPath },
      });
      edges.push({
        id: `${id}->memberOf->${fileId}`,
        source: id,
        target: fileId,
        layer: 'memberOf',
        weight: 5,
      });
    }
  }
  return { nodes, edges };
}
