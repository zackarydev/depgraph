/**
 * Markdown handler (mdast-based).
 *
 * Emits a single interleaved row stream:
 *   - owner NODE (heading/paragraph/sentence/…)
 *   - x/y slot NODE + x/y EDGE (structural position: indent by depth, stack in y)
 *   - memberOf EDGE to parent, next EDGE to previous sibling
 *
 * The position rule is an outline: x = depth * DX, y increments per emission.
 * That puts each node near its descent equilibrium (memberOf to parent is a
 * short diagonal; next between siblings is one DY apart) so the live layout
 * starts structured instead of collapsing into a circle.
 *
 * @module codegen/handlers/markdown
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';

export const extensions = ['.md', '.markdown'];

const DX = 120;
const DY = 28;
const FILE_GAP = 80;

export function handle(absPath, relPath, scanState) {
  const source = readFileSync(absPath, 'utf-8');
  const fileId = `file:${relPath}`;
  const rows = [];
  const baseY = (scanState && typeof scanState.yCursor === 'number') ? scanState.yCursor : 0;

  const ctx = {
    fileId,
    relPath,
    rows,
    headingStack: [],
    counters: new Map(),
    lastChild: new Map(),
    yIndex: 0,
    baseY,
  };

  emitNode(ctx, fileId, 'markdown-file', basename(relPath), 0);

  const tree = fromMarkdown(source);
  for (const child of tree.children) {
    visitBlock(child, parentForBlock(ctx, child), 1, ctx);
  }

  if (scanState) scanState.yCursor = baseY + ctx.yIndex * DY + FILE_GAP;

  return { rows };
}

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
  const text = inlineText(p);
  const id = nodeId(ctx, parentId, 'p');
  emitNode(ctx, id, 'paragraph', truncate(text, 80), depth);
  pushChild(ctx, parentId, id, 2);
  for (const s of splitSentences(text)) {
    const sid = nodeId(ctx, id, 's');
    emitNode(ctx, sid, 'sentence', truncate(s, 80), depth + 1);
    pushChild(ctx, id, sid, 1);
  }
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

// ─── emission helpers ────────────────────────────────

function emitNode(ctx, id, kind, label, depth) {
  const x = depth * DX;
  const y = ctx.baseY + (ctx.yIndex++) * DY;
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
  // Directional rest: child sits one indent to the right of parent.
  emitRestX(ctx, memberId, DX);

  const prev = ctx.lastChild.get(parentId);
  if (prev) {
    const nextId = `${prev}->next->${childId}`;
    ctx.rows.push({
      type: 'EDGE', op: 'add',
      id: nextId,
      source: prev, target: childId, layer: 'next', weight: 1,
    });
    // Directional rest: source=prev is one line above target=child → dy = -DY.
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
