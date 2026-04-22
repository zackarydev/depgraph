#!/usr/bin/env node
/**
 * Image → hypergraph producer.
 *
 * Emits a history.csv that represents a square image as a streaming
 * construction: pixels and edges are interwoven so the file reads as a
 * narrative where each new pixel "grows" from its already-placed neighbour(s).
 *
 *   - one `image-header` node carrying "W,H" in its label
 *   - an `image-root` edge from the header to `px:0,0`
 *   - for each pixel in row-major order:
 *       NODE add `px:X,Y` (kind=pixel, label="r,g,b")
 *       if X > 0: EDGE from `px:X-1,Y` (layer=next-x)   — grew from west
 *       if Y > 0: EDGE from `px:X,Y-1` (layer=next-y)   — grew from north
 *
 * Every non-corner pixel is born from 1-2 predecessors, giving a streaming
 * grid with interleaved nodes and edges rather than "all nodes, then all
 * edges". Each pixel still has one outgoing next-x and one outgoing next-y
 * edge (recorded by its *east* / *south* child when that child is born),
 * which preserves the full grid connectivity for traversal.
 *
 * Pixel positions are *not* emitted as x/y slot edges — main.js recognises
 * the `pixel` kind and pins + locks each pixel at (X*PIXEL_PITCH, Y*PIXEL_PITCH).
 *
 * CLI:
 *   node codegen/imagegen.mjs --size 32 --pattern gradient > runtime/image.csv
 *
 * Patterns: gradient (default), checker, ring.
 *
 * @module codegen/imagegen
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeRowLine, HEADER } from '../src/data/csv.js';

function clamp255(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function patternGradient(x, y, size) {
  const r = clamp255((x / (size - 1)) * 255);
  const g = clamp255((y / (size - 1)) * 255);
  const b = clamp255(128 + 127 * Math.sin((x + y) * Math.PI / size));
  return [r, g, b];
}

function patternChecker(x, y) {
  const on = ((x + y) & 1) === 0;
  return on ? [240, 240, 240] : [20, 20, 30];
}

function patternRing(x, y, size) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const d = Math.hypot(x - cx, y - cy);
  const maxD = Math.hypot(cx, cy);
  const t = d / maxD;
  const r = clamp255(255 * (1 - t));
  const g = clamp255(180 * Math.sin(t * Math.PI * 3));
  const b = clamp255(255 * t);
  return [r, g, b];
}

const PATTERNS = {
  gradient: patternGradient,
  checker:  patternChecker,
  ring:     patternRing,
};

/**
 * Build history rows for an image of `size`×`size` pixels.
 *
 * @param {number} size
 * @param {(x:number, y:number, size:number) => [number, number, number]} pickRGB
 * @returns {import('../src/core/types.js').HistoryRow[]}
 */
export function imageToRows(size, pickRGB) {
  const rows = [];
  let t = 0;

  rows.push({
    t: t++,
    type: 'NODE',
    op: 'add',
    id: 'img:meta',
    kind: 'image-header',
    label: `${size},${size}`,
    weight: 1,
  });

  rows.push({
    t: t++,
    type: 'EDGE',
    op: 'add',
    id: 'img:root',
    source: 'img:meta',
    target: 'px:0,0',
    layer: 'image-root',
    weight: 1,
  });

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pickRGB(x, y, size);
      const brightness = (r + g + b) / 3 / 255;
      rows.push({
        t: t++,
        type: 'NODE',
        op: 'add',
        id: `px:${x},${y}`,
        kind: 'pixel',
        label: `${r},${g},${b}`,
        weight: brightness,
      });
      if (x > 0) {
        rows.push({
          t: t++,
          type: 'EDGE',
          op: 'add',
          id: `nx:${x - 1},${y}`,
          source: `px:${x - 1},${y}`,
          target: `px:${x},${y}`,
          layer: 'next-x',
          weight: 1,
        });
      }
      if (y > 0) {
        rows.push({
          t: t++,
          type: 'EDGE',
          op: 'add',
          id: `ny:${x},${y - 1}`,
          source: `px:${x},${y - 1}`,
          target: `px:${x},${y}`,
          layer: 'next-y',
          weight: 1,
        });
      }
    }
  }

  return rows;
}

// ─── CLI ───────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  function argVal(flag, fallback) {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
  }

  const size = Number(argVal('--size', '32'));
  const patternName = argVal('--pattern', 'gradient');
  const outPath = argVal('--out', null);

  const pickRGB = PATTERNS[patternName];
  if (!pickRGB) {
    console.error(`unknown pattern: ${patternName}. options: ${Object.keys(PATTERNS).join(', ')}`);
    process.exit(1);
  }

  const rows = imageToRows(size, pickRGB);
  const text = [HEADER, ...rows.map(writeRowLine)].join('\n') + '\n';

  if (outPath) {
    writeFileSync(resolve(outPath), text, 'utf-8');
    console.error(`[imagegen] wrote ${rows.length} rows (${size}×${size} ${patternName}) → ${outPath}`);
  } else {
    process.stdout.write(text);
  }
}
