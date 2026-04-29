#!/usr/bin/env node
/**
 * README → history.csv, with each markdown image spliced in as an
 * image-as-hypergraph (see codegen/imagegen.mjs).
 *
 * The text flows in the left-hand column (x = depth * DX, y incrementing
 * per block). Every `image` mdast node triggers inline emission of a
 * 16×16 pixel grid at a right-hand origin (IMAGE_ORIGIN_X, current y),
 * so when you replay the history the image blooms right where the
 * markdown said `![alt](url)`.
 *
 * Synthetic patterns (gradient/ring/checker) cycle per image — the
 * actual PNG bytes aren't read; the demo is about narrative + visual
 * variety, not fidelity. Swap `imageToRows` for a real sampler later.
 *
 * Usage:
 *   node codegen/readmegen.mjs
 *   node codegen/readmegen.mjs --input README.md --out runtime/history.readme.csv
 *   node codegen/readmegen.mjs --image-size 16 --image-origin-x 1000
 *
 * @module codegen/readmegen
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';

import { writeRowLine, HEADER, validateRow } from '../src/data/csv.js';
import { imageToRows, PATTERNS } from './imagegen.mjs';
import { PIXEL_PITCH } from '../src/render/image-constants.js';

const DX = 120;
const DY = 28;
const PATTERN_CYCLE = ['gradient', 'ring', 'checker'];

// ─── main ────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  function argVal(flag, fallback) {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
  }

  const inputPath = resolve(argVal('--input', 'README.md'));
  const outPath = resolve(argVal('--out', 'runtime/history.readme.csv'));
  const imageSize = Number(argVal('--image-size', '16'));
  const imageOriginX = Number(argVal('--image-origin-x', '900'));

  if (!existsSync(inputPath)) {
    console.error(`[readmegen] file not found: ${inputPath}`);
    process.exit(1);
  }

  const source = readFileSync(inputPath, 'utf-8');
  const relPath = basename(inputPath);

  const ctx = {
    fileId: `file:${relPath}`,
    rows: [],
    headingStack: [],
    counters: new Map(),
    lastChild: new Map(),
    yIndex: 0,
    baseY: 0,
    imageSize,
    imageOriginX,
    imageIndex: 0,
  };

  emitNode(ctx, ctx.fileId, 'markdown-file', relPath, 0);

  const tree = fromMarkdown(source);
  for (const child of tree.children) {
    const parentId = parentForBlock(ctx, child);
    const top = ctx.headingStack[ctx.headingStack.length - 1];
    const blockDepth = child.type === 'heading'
      ? child.depth
      : (top ? top.depth + 1 : 1);
    visitBlock(child, parentId, blockDepth, ctx);
  }

  // Assign t and validate.
  const final = [];
  let t = 0;
  for (const row of ctx.rows) {
    const stamped = { ...row, t: t++ };
    const err = validateRow(stamped);
    if (err) {
      console.error(`[readmegen] dropping ${stamped.id}: ${err}`);
      continue;
    }
    final.push(stamped);
  }

  const text = [HEADER, ...final.map(writeRowLine)].join('\n') + '\n';
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, text, 'utf-8');
  console.error(`[readmegen] wrote ${final.length} rows (${ctx.imageIndex} images) → ${outPath}`);
}

// ─── block visitors (cribbed from handlers/markdown.mjs) ────────────

function parentForBlock(ctx, block) {
  if (block.type === 'heading') {
    while (ctx.headingStack.length && ctx.headingStack[ctx.headingStack.length - 1].depth >= block.depth) {
      ctx.headingStack.pop();
    }
    return ctx.headingStack.length
      ? ctx.headingStack[ctx.headingStack.length - 1].id
      : ctx.fileId;
  }
  return ctx.headingStack.length
    ? ctx.headingStack[ctx.headingStack.length - 1].id
    : ctx.fileId;
}

function visitBlock(node, parentId, depth, ctx) {
  switch (node.type) {
    case 'heading':       return emitHeading(node, parentId, ctx);
    case 'paragraph':     return emitParagraph(node, parentId, depth, ctx);
    case 'code':          return emitCode(node, parentId, depth, ctx);
    case 'list':          return emitList(node, parentId, depth, ctx);
    case 'blockquote':    return emitBlockquote(node, parentId, depth, ctx);
    case 'thematicBreak': return emitLeaf(node, parentId, depth, ctx, 'thematic-break', '———');
    case 'html':          return emitLeaf(node, parentId, depth, ctx, 'html-block', truncate(node.value, 60));
    default:              return null;
  }
}

function emitHeading(h, parentId, ctx) {
  const text = inlineText(h);
  const slug = slugify(text);
  const id = `${ctx.fileId}#h${h.depth}:${uniqueSlug(ctx, slug)}`;
  emitNode(ctx, id, 'heading', text, h.depth);
  pushChild(ctx, parentId, id, 4);
  ctx.headingStack.push({ id, depth: h.depth });
  return id;
}

function emitParagraph(p, parentId, depth, ctx) {
  const images = collectImages(p);
  const isImageOnly = images.length > 0 && p.children.every(c =>
    c.type === 'image' || (c.type === 'text' && !String(c.value || '').trim())
  );

  if (isImageOnly) {
    // The paragraph is a figure: skip the text carrier, emit images
    // directly under the enclosing section.
    for (const img of images) emitImageBlock(img, parentId, depth, ctx);
    return null;
  }

  const text = inlineText(p);
  const id = nodeId(ctx, parentId, 'p');
  emitNode(ctx, id, 'paragraph', truncate(text, 80), depth);
  pushChild(ctx, parentId, id, 2);
  for (const s of splitSentences(text)) {
    const sid = nodeId(ctx, id, 's');
    emitNode(ctx, sid, 'sentence', truncate(s, 80), depth + 1);
    pushChild(ctx, id, sid, 1);
  }
  // Any inline images nest under this paragraph.
  for (const img of images) emitImageBlock(img, id, depth + 1, ctx);
  return id;
}

function emitCode(c, parentId, depth, ctx) {
  const id = nodeId(ctx, parentId, 'code');
  const label = c.lang ? `\`\`\`${c.lang}` : '```';
  emitNode(ctx, id, 'code-block', label, depth);
  pushChild(ctx, parentId, id, 2);
  return id;
}

function emitList(l, parentId, depth, ctx) {
  const id = nodeId(ctx, parentId, l.ordered ? 'ol' : 'ul');
  emitNode(ctx, id, 'list', l.ordered ? 'ordered list' : 'list', depth);
  pushChild(ctx, parentId, id, 2);
  for (const item of l.children || []) {
    if (item.type !== 'listItem') continue;
    const itemId = nodeId(ctx, id, 'li');
    const itemText = item.children.map(inlineText).join(' ').trim();
    emitNode(ctx, itemId, 'list-item', truncate(itemText, 80), depth + 1);
    pushChild(ctx, id, itemId, 1);
    for (const child of item.children || []) {
      if (child.type === 'paragraph') {
        for (const s of splitSentences(inlineText(child))) {
          const sid = nodeId(ctx, itemId, 's');
          emitNode(ctx, sid, 'sentence', truncate(s, 80), depth + 2);
          pushChild(ctx, itemId, sid, 1);
        }
        for (const img of collectImages(child)) emitImageBlock(img, itemId, depth + 2, ctx);
      } else if (child.type === 'list') {
        emitList(child, itemId, depth + 2, ctx);
      } else {
        visitBlock(child, itemId, depth + 2, ctx);
      }
    }
  }
  return id;
}

function emitBlockquote(b, parentId, depth, ctx) {
  const id = nodeId(ctx, parentId, 'bq');
  const text = b.children.map(inlineText).join(' ').trim();
  emitNode(ctx, id, 'blockquote', truncate(text, 80), depth);
  pushChild(ctx, parentId, id, 2);
  for (const child of b.children || []) visitBlock(child, id, depth + 1, ctx);
  return id;
}

function emitLeaf(node, parentId, depth, ctx, kind, label) {
  const id = nodeId(ctx, parentId, kind);
  emitNode(ctx, id, kind, label, depth);
  pushChild(ctx, parentId, id, 1);
  return id;
}

// ─── image splicing ──────────────────────────────────

function emitImageBlock(imgNode, parentId, depth, ctx) {
  const alt = (imgNode.alt || imgNode.title || basename(imgNode.url || 'image')).trim();
  const patternName = PATTERN_CYCLE[ctx.imageIndex % PATTERN_CYCLE.length];
  const pickRGB = PATTERNS[patternName];

  // Anchor the image origin at the right-side column, vertically aligned
  // with the current text cursor. So when the replay reaches this moment,
  // pixels appear adjacent to the line that triggered them.
  const originX = ctx.imageOriginX;
  const originY = ctx.baseY + ctx.yIndex * DY;
  const size = ctx.imageSize;

  const headerId = `img:${originX},${originY}:meta`;

  // Image-header + pixels + edges. tStart=0 — the final stamping pass
  // renumbers every row in ctx.rows sequentially, so these t values
  // are just placeholders.
  const imgRows = imageToRows({ width: size, height: size, pickRGB, originX, originY });
  for (const row of imgRows) {
    const { t: _t, ...rest } = row;
    emitRaw(ctx, rest);
  }

  // No memberOf/next edges: the image-header is locked at its world
  // coord, but the other endpoint would feel a long-distance spring
  // pulling the text column toward the image column. Narrative linkage
  // comes from (a) the figure-caption + `describes` edge below and
  // (b) the t ordering in the CSV — the image emits right when its
  // markdown reference is encountered.

  // Advance the text cursor past the image's vertical extent so
  // subsequent images and paragraphs don't overlap this one.
  const imageHeightY = size * PIXEL_PITCH;
  const skipRows = Math.ceil(imageHeightY / DY) + 1;
  ctx.yIndex += skipRows;

  // Also emit a `describes` edge from the image-header to the alt text
  // so the graph carries a readable label for the figure. Attach to
  // a tiny sentence node so searching/hover shows "alt: ...".
  if (alt) {
    const altId = `${headerId}#alt`;
    // Place alt just above the image origin at the same column.
    emitAbsoluteNode(ctx, altId, 'figure-caption', truncate(alt, 80), originX, originY - PIXEL_PITCH);
    emitRaw(ctx, {
      type: 'EDGE', op: 'add',
      id: `${altId}->describes->${headerId}`,
      source: altId, target: headerId, layer: 'describes', weight: 1,
    });
  }

  ctx.imageIndex += 1;
}

function collectImages(node) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'image') out.push(n);
    if (n.children) for (const c of n.children) walk(c);
  })(node);
  return out;
}

// ─── emission helpers ────────────────────────────────

function emitRaw(ctx, row) {
  ctx.rows.push(row);
}

function emitNode(ctx, id, kind, label, depth) {
  const x = depth * DX;
  const y = ctx.baseY + (ctx.yIndex++) * DY;
  ctx.rows.push({ type: 'NODE', op: 'add', id, kind, label });
  emitPosition(ctx, id, x, y);
}

// Like emitNode but uses absolute world coords (no yIndex bump).
// Used for figure captions tied to an image's world origin.
function emitAbsoluteNode(ctx, id, kind, label, x, y) {
  ctx.rows.push({ type: 'NODE', op: 'add', id, kind, label });
  emitPosition(ctx, id, x, y);
}

function emitPosition(ctx, ownerId, x, y) {
  const xSlotId = `${ownerId}:pos:x`;
  const ySlotId = `${ownerId}:pos:y`;
  ctx.rows.push({ type: 'NODE', op: 'add', id: xSlotId, kind: 'slot', weight: x, label: String(x) });
  ctx.rows.push({ type: 'NODE', op: 'add', id: ySlotId, kind: 'slot', weight: y, label: String(y) });
  ctx.rows.push({ type: 'EDGE', op: 'add', id: xSlotId, source: ownerId, target: xSlotId, layer: 'x', weight: 1 });
  ctx.rows.push({ type: 'EDGE', op: 'add', id: ySlotId, source: ownerId, target: ySlotId, layer: 'y', weight: 1 });
}

function pushChild(ctx, parentId, childId, weight) {
  const memberId = `${childId}->memberOf->${parentId}`;
  ctx.rows.push({
    type: 'EDGE', op: 'add',
    id: memberId,
    source: childId, target: parentId, layer: 'memberOf', weight,
  });
  emitRestX(ctx, memberId, DX);

  const prev = ctx.lastChild.get(parentId);
  if (prev) {
    const nextId = `${prev}->next->${childId}`;
    ctx.rows.push({
      type: 'EDGE', op: 'add',
      id: nextId,
      source: prev, target: childId, layer: 'next', weight: 1,
    });
    emitRestY(ctx, nextId, -DY);
  }
  ctx.lastChild.set(parentId, childId);
}

function emitRestX(ctx, edgeId, dx) {
  const slotId = `${edgeId}:rest-x`;
  ctx.rows.push({ type: 'NODE', op: 'add', id: slotId, kind: 'slot', weight: dx, label: String(dx) });
  ctx.rows.push({ type: 'EDGE', op: 'add', id: slotId, source: edgeId, target: slotId, layer: 'rest-x', weight: 1 });
}

function emitRestY(ctx, edgeId, dy) {
  const slotId = `${edgeId}:rest-y`;
  ctx.rows.push({ type: 'NODE', op: 'add', id: slotId, kind: 'slot', weight: dy, label: String(dy) });
  ctx.rows.push({ type: 'EDGE', op: 'add', id: slotId, source: edgeId, target: slotId, layer: 'rest-y', weight: 1 });
}

// ─── misc helpers ────────────────────────────────────

function nodeId(ctx, parentId, kind) {
  const key = `${parentId}::${kind}`;
  const n = (ctx.counters.get(key) || 0) + 1;
  ctx.counters.set(key, n);
  return `${parentId}/${kind}:${n}`;
}

function uniqueSlug(ctx, slug) {
  const key = `__slug:${slug}`;
  const n = (ctx.counters.get(key) || 0) + 1;
  ctx.counters.set(key, n);
  return n === 1 ? slug : `${slug}-${n}`;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
}

function truncate(s, n) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function inlineText(node) {
  if (!node) return '';
  if (typeof node.value === 'string' && !node.children) return node.value;
  if (!node.children) return '';
  return node.children.map(inlineText).join('');
}

const ABBREV = /\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Dr|St|cf|approx|Ex)\.$/i;
function splitSentences(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z"'\[(])/);
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && ABBREV.test(last)) {
      out[out.length - 1] = last + ' ' + p;
    } else {
      out.push(p);
    }
  }
  return out.filter(s => s.length > 0);
}

main();
