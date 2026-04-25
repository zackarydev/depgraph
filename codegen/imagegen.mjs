#!/usr/bin/env node
/**
 * Image → hypergraph producer.
 *
 * Emits rows that represent a square image as a streaming construction:
 * pixels and edges are interwoven so the file reads as a narrative where
 * each new pixel "grows" from its already-placed neighbour(s).
 *
 *   - one `image-header` node with id `img:<ox>,<oy>:meta`, label "W,H"
 *   - an `image-root` edge from the header to the top-left pixel
 *   - for each pixel in row-major order:
 *       NODE add `px:<ox>,<oy>:<gx>,<gy>` (kind=pixel, label="r,g,b")
 *       if gx > 0: EDGE from the west predecessor (layer=next-x)
 *       if gy > 0: EDGE from the north predecessor (layer=next-y)
 *
 * The origin (ox, oy) is baked into every id so multiple images can
 * coexist in one history file without colliding. main.js parses the
 * origin from the id and pins each pixel at (ox + gx*PITCH, oy + gy*PITCH).
 *
 * Pixel positions are *not* emitted as x/y slot edges — main.js recognises
 * the `pixel` kind and pins + locks each pixel from its id alone.
 *
 * CLI:
 *   node codegen/imagegen.mjs --size 16 --pattern gradient > runtime/image.csv
 *   node codegen/imagegen.mjs --size 16 --origin-x 1000 --origin-y 200 --out ...
 *   node codegen/imagegen.mjs --size 32 --url ./image.png > runtime/image.csv
 *
 * Patterns: gradient (default), checker, ring.
 *
 * @module codegen/imagegen
 */

import * as Jimp from 'jimp';
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

async function imageFromUrl(url, sizeArg) {
  if (!url) {
    return false;
  }

  try {
    let image = await Jimp.Jimp.read(url);
    
    // If the user explicitly provided a size, resize to that square bounding box
    // Otherwise, keep the image's intrinsic dimensions
    if (sizeArg) {
      image = await image.resize({
        w: sizeArg,
        h: sizeArg,
        mode: Jimp.ResizeStrategy.NEAREST_NEIGHBOR,
      });
    }
    
    const width = image.bitmap.width;
    const height = image.bitmap.height;

    const pickRGB = (x, y) => {
      const hex = image.getPixelColor(x, y);
      const rgba = Jimp.intToRGBA(hex);
      return [rgba.r, rgba.g, rgba.b];
    };
    return { pickRGB, width, height };
  } catch (err) {
    console.error(`Failed to load image from URL: ${url}\n`, err);
    process.exit(1);
  }
}

export const PATTERNS = {
  gradient: patternGradient,
  checker:  patternChecker,
  ring:     patternRing,
};

/**
 * Build history rows for an image of `size`×`size` pixels.
 *
 * @param {object}   opts
 * @param {number}   opts.size      grid side length
 * @param {(x:number,y:number,size:number)=>[number,number,number]} opts.pickRGB
 * @param {number}  [opts.originX=0] world-coord origin x (top-left corner)
 * @param {number}  [opts.originY=0] world-coord origin y
 * @param {number}  [opts.tStart=0]  starting t offset (useful when splicing
 *                                   into a larger stream that assigns t later)
 * @returns {import('../src/core/types.js').HistoryRow[]}
 */
export function imageToRows({ width, height, pickRGB, originX = 0, originY = 0, tStart = 0 }) {
  const rows = [];
  let t = tStart;
  const ox = originX | 0;
  const oy = originY | 0;
  const headerId = `img:${ox},${oy}:meta`;
  const pixId = (gx, gy) => `px:${ox},${oy}:${gx},${gy}`;

  rows.push({
    t: t++,
    type: 'NODE',
    op: 'add',
    id: headerId,
    kind: 'image-header',
    label: `${width},${height}`,
    weight: 1,
  });

  rows.push({
    t: t++,
    type: 'EDGE',
    op: 'add',
    id: `img:${ox},${oy}:root`,
    source: headerId,
    target: pixId(0, 0),
    layer: 'image-root',
    weight: 1,
  });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pickRGB(x, y, width);
      const brightness = (r + g + b) / 3 / 255;
      rows.push({
        t: t++,
        type: 'NODE',
        op: 'add',
        id: pixId(x, y),
        kind: 'pixel',
        label: `${r},${g},${b}`,
        weight: brightness,
      });
      if (x > 0) {
        rows.push({
          t: t++,
          type: 'EDGE',
          op: 'add',
          id: `nx:${ox},${oy}:${x - 1},${y}`,
          source: pixId(x - 1, y),
          target: pixId(x, y),
          layer: 'next-x',
          weight: 1,
        });
      }
      if (y > 0) {
        rows.push({
          t: t++,
          type: 'EDGE',
          op: 'add',
          id: `ny:${ox},${oy}:${x},${y - 1}`,
          source: pixId(x, y - 1),
          target: pixId(x, y),
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

  const url = argVal('--url', null);
  let size = Number(argVal('--size', '16'));
  const patternName = argVal('--pattern', 'gradient');
  const originX = Number(argVal('--origin-x', '0'));
  const originY = Number(argVal('--origin-y', '0'));
  const outPath = argVal('--out', null);

  let width = size;
  let height = size;

  let pickRGB;
  if(url) {
    const { pickRGB: _pickRGB, width: imgWidth, height: imgHeight } = await imageFromUrl(url, size);
    pickRGB = _pickRGB;
    width = imgWidth;
    height = imgHeight;
  } else {
    pickRGB = PATTERNS[patternName];
  }

  if (!pickRGB) {
    console.error(`unknown pattern: ${patternName}. options: ${Object.keys(PATTERNS).join(', ')}`);
    process.exit(1);
  }

  const rows = imageToRows({ width, height, pickRGB, originX, originY });
  const text = [HEADER, ...rows.map(writeRowLine)].join('\n') + '\n';

  if (outPath) {
    const fullPath = resolve(outPath);
    writeFileSync(fullPath, text, 'utf-8');
    console.error(`[imagegen] wrote ${rows.length} rows (${size}×${size} ${patternName} @ ${originX},${originY}) → ${fullPath}`);
  } else {
    process.stdout.write(text);
  }
}
