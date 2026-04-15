/**
 * Phase 10f handler: JSON files.
 *
 * Every JSON file becomes a NODE kind=json-file. Top-level keys become
 * NODE kind=json-key, with one exception: `package.json` gets richer
 * shapes — `scripts.*` becomes kind=script and dependencies become
 * kind=dependency. Other package.json fields (name, version, keywords,
 * description, ...) still become json-key nodes so editing one of them
 * produces a precise diff on that single key, not a "whole file changed"
 * blast radius.
 *
 * Each node carries a `signature`: a stable fingerprint of its real
 * content. The watcher diffs by signature, so cosmetic file shifts (line
 * counts, formatting whitespace that doesn't affect parsed JSON) do not
 * trigger updates.
 *
 * @module codegen/handlers/json
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const extensions = ['.json'];

/** Stable JSON stringification — sorted keys for object signatures. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

const PKG_SPECIAL_KEYS = new Set(['scripts', 'dependencies', 'devDependencies', 'peerDependencies']);

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
      signature: 'parse-error',
    });
    return { nodes, edges };
  }

  // File node — empty signature so re-saves with no content change are silent.
  nodes.push({
    id: fileId,
    kind: 'json-file',
    label: basename(relPath),
    payload: { path: relPath, lines: source.split('\n').length },
    signature: '',
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
          signature: String(body),
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
          signature: `${depKey}:${version}`,
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
  }

  // Top-level keys as json-key nodes (skip the special package.json keys we
  // already covered above). For other JSON files, every key becomes a node.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (isPkg && PKG_SPECIAL_KEYS.has(key)) continue;
      const id = `${fileId}#${key}`;
      nodes.push({
        id,
        kind: 'json-key',
        label: key,
        payload: { type: typeof value, file: relPath },
        signature: stableStringify(value),
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
