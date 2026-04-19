/**
 * Phase 10f handler: Markdown files (mdast-based).
 *
 * Parses to an mdast (markdown AST) and emits a hierarchy:
 *
 *   file:README.md (markdown-file)
 *     ├── heading nodes (kind=heading) — section anchors, nested by depth
 *     │     ├── paragraph nodes (kind=paragraph)
 *     │     │     └── sentence nodes (kind=sentence)
 *     │     ├── code-block nodes (kind=code-block)
 *     │     ├── list nodes (kind=list) → list-item → sentence
 *     │     ├── blockquote nodes
 *     │     ├── image nodes
 *     │     └── thematic-break / html nodes
 *
 * All child→parent containment uses `memberOf` (existing convention).
 * Sequential siblings under the same parent are linked with `next` edges.
 *
 * @module codegen/handlers/markdown
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';

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

  const tree = fromMarkdown(source);
  const ctx = { fileId, relPath, nodes, edges, headingStack: [], counters: new Map(), siblingStacks: [[]] };

  for (const child of tree.children) {
    visitBlock(child, parentForBlock(ctx, child), ctx);
  }
  return { nodes, edges };
}

function parentForBlock(ctx, block) {
  if (block.type === 'heading') {
    while (ctx.headingStack.length && ctx.headingStack[ctx.headingStack.length - 1].depth >= block.depth) {
      ctx.headingStack.pop();
    }
    const parent = ctx.headingStack.length
      ? ctx.headingStack[ctx.headingStack.length - 1].id
      : ctx.fileId;
    return parent;
  }
  return ctx.headingStack.length
    ? ctx.headingStack[ctx.headingStack.length - 1].id
    : ctx.fileId;
}

function visitBlock(node, parentId, ctx) {
  switch (node.type) {
    case 'heading':       return emitHeading(node, parentId, ctx);
    case 'paragraph':     return emitParagraph(node, parentId, ctx);
    case 'code':          return emitCode(node, parentId, ctx);
    case 'list':          return emitList(node, parentId, ctx);
    case 'blockquote':    return emitBlockquote(node, parentId, ctx);
    case 'thematicBreak': return emitLeaf(node, parentId, ctx, 'thematic-break', '———');
    case 'html':          return emitLeaf(node, parentId, ctx, 'html-block', truncate(node.value, 60));
    default:              return null;
  }
}

function emitHeading(h, parentId, ctx) {
  const text = inlineText(h);
  const slug = slugify(text);
  const id = `${ctx.fileId}#h${h.depth}:${uniqueSlug(ctx, slug)}`;
  ctx.nodes.push({
    id,
    kind: 'heading',
    label: text,
    payload: { file: ctx.relPath, line: h.position?.start?.line, depth: h.depth },
  });
  pushChild(ctx, parentId, id, 4);
  ctx.headingStack.push({ id, depth: h.depth });
  return id;
}

function emitParagraph(p, parentId, ctx) {
  const text = inlineText(p);
  const id = nodeId(ctx, parentId, 'p');
  ctx.nodes.push({
    id,
    kind: 'paragraph',
    label: truncate(text, 80),
    payload: { file: ctx.relPath, line: p.position?.start?.line, text },
  });
  pushChild(ctx, parentId, id, 2);
  // Sentences as children of the paragraph.
  const sentences = splitSentences(text);
  for (const s of sentences) {
    const sid = nodeId(ctx, id, 's');
    ctx.nodes.push({
      id: sid,
      kind: 'sentence',
      label: truncate(s, 80),
      payload: { file: ctx.relPath, text: s },
    });
    pushChild(ctx, id, sid, 1);
  }
  return id;
}

function emitCode(c, parentId, ctx) {
  const id = nodeId(ctx, parentId, 'code');
  ctx.nodes.push({
    id,
    kind: 'code-block',
    label: c.lang ? `\`\`\`${c.lang}` : '```',
    payload: { file: ctx.relPath, line: c.position?.start?.line, lang: c.lang || null, value: c.value },
  });
  pushChild(ctx, parentId, id, 2);
  return id;
}

function emitList(l, parentId, ctx) {
  const id = nodeId(ctx, parentId, l.ordered ? 'ol' : 'ul');
  ctx.nodes.push({
    id,
    kind: 'list',
    label: l.ordered ? 'ordered list' : 'list',
    payload: { file: ctx.relPath, line: l.position?.start?.line, ordered: !!l.ordered },
  });
  pushChild(ctx, parentId, id, 2);
  for (const item of l.children || []) {
    if (item.type !== 'listItem') continue;
    const itemId = nodeId(ctx, id, 'li');
    const itemText = item.children.map(inlineText).join(' ').trim();
    ctx.nodes.push({
      id: itemId,
      kind: 'list-item',
      label: truncate(itemText, 80),
      payload: { file: ctx.relPath, line: item.position?.start?.line, text: itemText },
    });
    pushChild(ctx, id, itemId, 1);
    // Walk nested blocks inside the list item.
    for (const child of item.children || []) {
      if (child.type === 'paragraph') {
        // Sentences directly under the list item — skip the wrapping paragraph layer here.
        for (const s of splitSentences(inlineText(child))) {
          const sid = nodeId(ctx, itemId, 's');
          ctx.nodes.push({
            id: sid,
            kind: 'sentence',
            label: truncate(s, 80),
            payload: { file: ctx.relPath, text: s },
          });
          pushChild(ctx, itemId, sid, 1);
        }
      } else if (child.type === 'list') {
        emitList(child, itemId, ctx);
      } else {
        visitBlock(child, itemId, ctx);
      }
    }
  }
  return id;
}

function emitBlockquote(b, parentId, ctx) {
  const id = nodeId(ctx, parentId, 'bq');
  const text = b.children.map(inlineText).join(' ').trim();
  ctx.nodes.push({
    id,
    kind: 'blockquote',
    label: truncate(text, 80),
    payload: { file: ctx.relPath, line: b.position?.start?.line, text },
  });
  pushChild(ctx, parentId, id, 2);
  for (const child of b.children || []) visitBlock(child, id, ctx);
  return id;
}

function emitLeaf(node, parentId, ctx, kind, label) {
  const id = nodeId(ctx, parentId, kind);
  ctx.nodes.push({
    id,
    kind,
    label,
    payload: { file: ctx.relPath, line: node.position?.start?.line },
  });
  pushChild(ctx, parentId, id, 1);
  return id;
}

// ─── helpers ─────────────────────────────────────────

function pushChild(ctx, parentId, childId, weight) {
  ctx.edges.push({
    id: `${childId}->memberOf->${parentId}`,
    source: childId,
    target: parentId,
    layer: 'memberOf',
    weight,
  });
  // `next` edge between consecutive siblings under the same parent.
  if (!ctx.counters.has(`__last:${parentId}`)) {
    ctx.counters.set(`__last:${parentId}`, childId);
    return;
  }
  const prev = ctx.counters.get(`__last:${parentId}`);
  ctx.edges.push({
    id: `${prev}->next->${childId}`,
    source: prev,
    target: childId,
    layer: 'next',
    weight: 1,
  });
  ctx.counters.set(`__last:${parentId}`, childId);
}

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

// Concatenate all inline text under a node, ignoring formatting but keeping
// link text and inline code as their literal contents.
function inlineText(node) {
  if (!node) return '';
  if (typeof node.value === 'string' && !node.children) return node.value;
  if (!node.children) return '';
  return node.children.map(inlineText).join('');
}

// Sentence split on prose. Avoids common abbreviations.
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
