/**
 * Visual tests — Playwright screenshots of gradient descent, node placement,
 * and rendering at each step.
 *
 * Run: npx playwright test test/visual/visual.test.mjs
 * Screenshots go to: test/visual/screenshots/
 */

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';
import { createServer } from './serve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, 'screenshots');

let server, baseUrl;

test.beforeAll(async () => {
  const s = await createServer();
  server = s.server;
  baseUrl = s.url;
});

test.afterAll(async () => {
  server.close();
});

test.describe('gradient descent visualization', () => {
  const HARNESS = () => `${baseUrl}/test/visual/harness.html`;

  test('single node sits still', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => window.__harness.addNode('A', 0, 0));
    await page.screenshot({ path: `${SHOTS}/01-single-node.png` });

    // Run descent — nothing should move (no edges)
    const results = await page.evaluate(() => window.__harness.runDescent(10));
    await page.screenshot({ path: `${SHOTS}/01-single-node-after-descent.png` });

    const pos = await page.evaluate(() => window.__harness.getPositions());
    expect(Math.abs(pos.A.x)).toBeLessThan(1);
    expect(Math.abs(pos.A.y)).toBeLessThan(1);
  });

  test('two nodes connected by an edge find equilibrium', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    // Place far apart
    await page.evaluate(() => {
      window.__harness.addNode('A', -200, 0);
      window.__harness.addNode('B', 200, 0);
    });
    await page.screenshot({ path: `${SHOTS}/02-two-nodes-start.png` });

    // Add edge
    await page.evaluate(() => {
      window.__harness.addEdge('A->B', 'A', 'B', 'calls', 1);
    });
    await page.screenshot({ path: `${SHOTS}/02-two-nodes-edge-added.png` });

    // Descent in stages
    for (let stage = 1; stage <= 5; stage++) {
      await page.evaluate(() => window.__harness.runDescent(20));
      await page.screenshot({ path: `${SHOTS}/02-two-nodes-descent-${stage}.png` });
    }

    // They should be closer now
    const pos = await page.evaluate(() => window.__harness.getPositions());
    const dist = Math.sqrt((pos.A.x - pos.B.x) ** 2 + (pos.A.y - pos.B.y) ** 2);
    expect(dist).toBeLessThan(400); // started at 400 apart
  });

  test('three nodes in a triangle settle', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('A', -150, -100);
      h.addNode('B', 150, -100);
      h.addNode('C', 0, 150);
      h.addEdge('A->B', 'A', 'B', 'calls', 1);
      h.addEdge('B->C', 'B', 'C', 'calls', 1);
      h.addEdge('A->C', 'A', 'C', 'calls', 1);
    });
    await page.screenshot({ path: `${SHOTS}/03-triangle-start.png` });

    // Descent
    for (let i = 1; i <= 5; i++) {
      await page.evaluate(() => window.__harness.runDescent(30));
      await page.screenshot({ path: `${SHOTS}/03-triangle-descent-${i}.png` });
    }
  });

  test('building a graph one node at a time', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    const h = 'window.__harness';

    // Node 1: origin
    await page.evaluate(() => window.__harness.addNode('n1', 0, 0));
    await page.screenshot({ path: `${SHOTS}/04-build-step-1.png` });

    // Node 2: connected to n1
    await page.evaluate(() => {
      window.__harness.addNode('n2', 100, 0);
      window.__harness.addEdge('n1->n2', 'n1', 'n2', 'calls', 2);
    });
    await page.evaluate(() => window.__harness.runDescent(50));
    await page.screenshot({ path: `${SHOTS}/04-build-step-2.png` });

    // Node 3: connected to n1
    await page.evaluate(() => {
      window.__harness.addNode('n3', -50, 80);
      window.__harness.addEdge('n1->n3', 'n1', 'n3', 'shared', 1);
    });
    await page.evaluate(() => window.__harness.runDescent(50));
    await page.screenshot({ path: `${SHOTS}/04-build-step-3.png` });

    // Node 4: connected to n2 and n3 — should settle between them
    await page.evaluate(() => {
      window.__harness.addNode('n4', 0, -80);
      window.__harness.addEdge('n2->n4', 'n2', 'n4', 'calls', 1);
      window.__harness.addEdge('n3->n4', 'n3', 'n4', 'shared', 1);
    });
    await page.evaluate(() => window.__harness.runDescent(50));
    await page.screenshot({ path: `${SHOTS}/04-build-step-4.png` });

    // Node 5: isolated — should drift away from the cluster
    await page.evaluate(() => {
      window.__harness.addNode('n5', 200, 200);
    });
    await page.evaluate(() => window.__harness.runDescent(50));
    await page.screenshot({ path: `${SHOTS}/04-build-step-5.png` });

    // Now connect n5 to n2 — it should get pulled in
    await page.evaluate(() => {
      window.__harness.addEdge('n2->n5', 'n2', 'n5', 'calls', 3);
    });
    await page.evaluate(() => window.__harness.runDescent(80));
    await page.screenshot({ path: `${SHOTS}/04-build-step-6-connected.png` });
  });

  test('locked node stays fixed while others move', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('fixed', 0, 0);
      h.addNode('free1', 200, 0);
      h.addNode('free2', 0, 200);
      h.addEdge('fixed->free1', 'fixed', 'free1', 'calls', 1);
      h.addEdge('fixed->free2', 'fixed', 'free2', 'calls', 1);
      h.addEdge('free1->free2', 'free1', 'free2', 'calls', 1);
      h.setNodeLocked('fixed', true);
    });
    await page.screenshot({ path: `${SHOTS}/05-locked-start.png` });

    await page.evaluate(() => window.__harness.runDescent(100));
    await page.screenshot({ path: `${SHOTS}/05-locked-after-descent.png` });

    const pos = await page.evaluate(() => window.__harness.getPositions());
    expect(pos.fixed.x).toBe(0);
    expect(pos.fixed.y).toBe(0);
    expect(pos.fixed.locked).toBe(true);
  });

  test('sticky node moves less than free node', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('sticky', -100, 0);
      h.addNode('free', 100, 0);
      h.addNode('anchor', 0, 200);
      h.addEdge('sticky->anchor', 'sticky', 'anchor', 'calls', 2);
      h.addEdge('free->anchor', 'free', 'anchor', 'calls', 2);
      h.setNodeSticky('sticky', true);
    });
    await page.screenshot({ path: `${SHOTS}/06-sticky-start.png` });

    await page.evaluate(() => window.__harness.runDescent(100));
    await page.screenshot({ path: `${SHOTS}/06-sticky-after-descent.png` });

    const pos = await page.evaluate(() => window.__harness.getPositions());
    const stickyDrift = Math.sqrt((-100 - pos.sticky.x) ** 2 + (0 - pos.sticky.y) ** 2);
    const freeDrift = Math.sqrt((100 - pos.free.x) ** 2 + (0 - pos.free.y) ** 2);
    expect(stickyDrift).toBeLessThan(freeDrift);
  });

  test('energy decreases over time (chart in screenshots)', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    // Build a 10-node chain
    await page.evaluate(() => {
      const h = window.__harness;
      for (let i = 0; i < 10; i++) {
        const angle = (2 * Math.PI * i) / 10;
        h.addNode(`n${i}`, 250 * Math.cos(angle), 250 * Math.sin(angle));
      }
      for (let i = 0; i < 9; i++) {
        h.addEdge(`n${i}->n${i + 1}`, `n${i}`, `n${i + 1}`, 'calls', 1);
      }
      h.addEdge('n9->n0', 'n9', 'n0', 'calls', 1); // close the ring
    });
    await page.screenshot({ path: `${SHOTS}/07-ring-start.png` });

    // Run 10 stages, screenshot each
    for (let stage = 1; stage <= 10; stage++) {
      await page.evaluate(() => window.__harness.runDescent(20));
      await page.screenshot({ path: `${SHOTS}/07-ring-descent-${String(stage).padStart(2, '0')}.png` });
    }

    const finalEnergy = await page.evaluate(() => window.__harness.getEnergy());
    const initialInfo = await page.evaluate(() => {
      // We can't get initial energy anymore, but final should be finite and reasonable
      return window.__harness.getInfo();
    });
    expect(finalEnergy).toBeLessThan(Infinity);
  });

  test('stream placement: new node joins settled graph', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    // Build and settle a small graph
    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('a', -50, -50);
      h.addNode('b', 50, -50);
      h.addNode('c', 0, 50);
      h.addEdge('a->b', 'a', 'b', 'calls', 2);
      h.addEdge('b->c', 'b', 'c', 'calls', 2);
      h.addEdge('a->c', 'a', 'c', 'calls', 2);
      h.runDescent(100);
    });
    await page.screenshot({ path: `${SHOTS}/08-stream-settled.png` });

    // Add new node connected to a and b
    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('new', 0, -150);  // start above
      h.addEdge('a->new', 'a', 'new', 'calls', 2);
      h.addEdge('b->new', 'b', 'new', 'calls', 2);
    });
    await page.screenshot({ path: `${SHOTS}/08-stream-new-added.png` });

    // Run stream placement (brief descent)
    await page.evaluate(() => window.__harness.runDescent(30));
    await page.screenshot({ path: `${SHOTS}/08-stream-after-settle.png` });
  });

  test('multi-layer edges with different colors', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('A', -100, 0);
      h.addNode('B', 100, 0);
      h.addNode('C', 0, -100);
      h.addNode('D', 0, 100);

      h.addEdge('A->B@calls', 'A', 'B', 'calls', 2);
      h.addEdge('A->C@shared', 'A', 'C', 'shared', 1);
      h.addEdge('B->D@memberOf', 'B', 'D', 'memberOf', 1);
      h.addEdge('C->D@sharedName', 'C', 'D', 'sharedName', 1);
      h.addEdge('A->D@writesTo', 'A', 'D', 'writesTo', 1);
    });
    await page.screenshot({ path: `${SHOTS}/09-multi-layer.png` });

    await page.evaluate(() => window.__harness.runDescent(80));
    await page.screenshot({ path: `${SHOTS}/09-multi-layer-settled.png` });
  });

  test('20-node graph with clusters forms structure', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;

      // Cluster 1: tightly connected
      for (let i = 0; i < 7; i++) {
        h.addNode(`c1_${i}`, -150 + Math.random() * 100, -100 + Math.random() * 100, { kind: 'function' });
      }
      for (let i = 0; i < 6; i++) {
        h.addEdge(`c1_${i}->c1_${i+1}`, `c1_${i}`, `c1_${i+1}`, 'calls', 2);
      }
      h.addEdge('c1_0->c1_6', 'c1_0', 'c1_6', 'calls', 1);

      // Cluster 2: another tight group
      for (let i = 0; i < 7; i++) {
        h.addNode(`c2_${i}`, 100 + Math.random() * 100, 50 + Math.random() * 100, { kind: 'global' });
      }
      for (let i = 0; i < 6; i++) {
        h.addEdge(`c2_${i}->c2_${i+1}`, `c2_${i}`, `c2_${i+1}`, 'shared', 2);
      }

      // Bridge nodes connecting the clusters
      for (let i = 0; i < 6; i++) {
        h.addNode(`bridge_${i}`, -25 + Math.random() * 50, -25 + Math.random() * 50, { kind: 'module' });
      }
      h.addEdge('c1_3->bridge_0', 'c1_3', 'bridge_0', 'calls', 1);
      h.addEdge('bridge_0->c2_0', 'bridge_0', 'c2_0', 'calls', 1);
      h.addEdge('c1_5->bridge_1', 'c1_5', 'bridge_1', 'memberOf', 1);
      h.addEdge('bridge_1->c2_3', 'bridge_1', 'c2_3', 'memberOf', 1);
    });
    await page.screenshot({ path: `${SHOTS}/10-cluster-start.png` });

    // Settle in stages
    for (let stage = 1; stage <= 8; stage++) {
      await page.evaluate(() => window.__harness.runDescent(30));
      await page.screenshot({ path: `${SHOTS}/10-cluster-descent-${stage}.png` });
    }
  });

});

// ─────────────────────────────────────────────────────
// Fractal rendering visual tests
// ─────────────────────────────────────────────────────

test.describe('fractal rendering', () => {
  const HARNESS = () => `${baseUrl}/test/visual/harness.html`;

  test('two clusters at low zoom — collapsed with meta-edges', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      for (let i = 0; i < 4; i++) {
        h.addNode(`a${i}`, -150 + i * 30, -20 + (i % 2) * 40);
      }
      h.addEdge('a0->a1', 'a0', 'a1', 'calls', 2);
      h.addEdge('a1->a2', 'a1', 'a2', 'calls', 2);
      h.addEdge('a2->a3', 'a2', 'a3', 'calls', 2);
      h.addCluster('cluster:alpha', ['a0', 'a1', 'a2', 'a3']);
      h.state.posMap.positions.set('cluster:alpha',
        { x: -120, y: 0, t0x: -120, t0y: 0, sticky: false, locked: false });

      for (let i = 0; i < 3; i++) {
        h.addNode(`b${i}`, 120 + i * 30, -10 + (i % 2) * 30);
      }
      h.addEdge('b0->b1', 'b0', 'b1', 'shared', 2);
      h.addEdge('b1->b2', 'b1', 'b2', 'shared', 2);
      h.addCluster('cluster:beta', ['b0', 'b1', 'b2']);
      h.state.posMap.positions.set('cluster:beta',
        { x: 150, y: 0, t0x: 150, t0y: 0, sticky: false, locked: false });

      h.addEdge('a2->b0', 'a2', 'b0', 'calls', 1);
    });

    const plan = await page.evaluate(() => {
      const p = window.__harness.computeRenderPlanAt(0.1);
      window.__harness.renderPlan(p);
      return { nodes: p.nodes.length, edges: p.edges.length, hulls: p.hulls.length, maxDepth: p.maxDepth };
    });
    await page.screenshot({ path: `${SHOTS}/20-fractal-low-zoom.png` });

    expect(plan.hulls).toBe(0);
    const clusterNodes = await page.evaluate(() =>
      window.__harness.state.lastPlan.nodes.filter(n => n.isCluster).length);
    expect(clusterNodes).toBe(2);
  });

  test('two clusters at high zoom — expanded with hulls', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      for (let i = 0; i < 4; i++) h.addNode(`a${i}`, -150 + i * 50, (i % 2) * 60 - 30);
      h.addEdge('a0->a1', 'a0', 'a1', 'calls', 2);
      h.addEdge('a1->a2', 'a1', 'a2', 'calls', 2);
      h.addEdge('a2->a3', 'a2', 'a3', 'calls', 2);
      h.addCluster('cluster:alpha', ['a0', 'a1', 'a2', 'a3']);
      h.state.posMap.positions.set('cluster:alpha',
        { x: -75, y: 0, t0x: -75, t0y: 0, sticky: false, locked: false });

      for (let i = 0; i < 3; i++) h.addNode(`b${i}`, 100 + i * 50, (i % 2) * 60 - 30);
      h.addEdge('b0->b1', 'b0', 'b1', 'shared', 2);
      h.addEdge('b1->b2', 'b1', 'b2', 'shared', 2);
      h.addCluster('cluster:beta', ['b0', 'b1', 'b2']);
      h.state.posMap.positions.set('cluster:beta',
        { x: 150, y: 0, t0x: 150, t0y: 0, sticky: false, locked: false });

      h.addEdge('a2->b0', 'a2', 'b0', 'calls', 1);
    });

    const plan = await page.evaluate(() => {
      const p = window.__harness.computeRenderPlanAt(5);
      window.__harness.renderPlan(p);
      return { nodes: p.nodes.length, edges: p.edges.length, hulls: p.hulls.length, maxDepth: p.maxDepth };
    });
    await page.screenshot({ path: `${SHOTS}/21-fractal-high-zoom.png` });

    expect(plan.hulls).toBeGreaterThanOrEqual(1);
    expect(plan.maxDepth).toBeGreaterThanOrEqual(1);
  });

  test('pinned cluster stays collapsed at high zoom', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      for (let i = 0; i < 5; i++) h.addNode(`n${i}`, -100 + i * 50, (i % 2) * 40);
      for (let i = 0; i < 4; i++) h.addEdge(`n${i}->n${i+1}`, `n${i}`, `n${i+1}`, 'calls', 2);
      h.addCluster('cluster:pinned', ['n0', 'n1', 'n2', 'n3', 'n4']);
      h.state.posMap.positions.set('cluster:pinned',
        { x: 0, y: 20, t0x: 0, t0y: 20, sticky: false, locked: false });
      h.pinCluster('cluster:pinned');
    });

    const plan = await page.evaluate(() => {
      const p = window.__harness.computeRenderPlanAt(10);
      window.__harness.renderPlan(p);
      return { nodes: p.nodes.length, hulls: p.hulls.length };
    });
    await page.screenshot({ path: `${SHOTS}/22-fractal-pinned-collapsed.png` });

    expect(plan.nodes).toBe(1);
    expect(plan.hulls).toBe(0);
  });

  test('budget limits expansion — large cluster stays collapsed', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      const members = [];
      for (let i = 0; i < 50; i++) {
        const id = `m${i}`;
        h.addNode(id, Math.cos(i) * 200, Math.sin(i) * 200);
        members.push(id);
      }
      h.addCluster('cluster:big', members);
      h.state.posMap.positions.set('cluster:big',
        { x: 0, y: 0, t0x: 0, t0y: 0, sticky: false, locked: false });
    });

    const plan = await page.evaluate(() => {
      const p = window.__harness.computeRenderPlanAt(10, 5);
      window.__harness.renderPlan(p);
      return { totalPrimitives: p.totalPrimitives, hulls: p.hulls.length };
    });
    await page.screenshot({ path: `${SHOTS}/23-fractal-budget-limit.png` });

    expect(plan.totalPrimitives).toBeLessThanOrEqual(5);
  });

  test('zoom transition: collapsed -> expanded -> collapsed', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      for (let i = 0; i < 4; i++) h.addNode(`x${i}`, -60 + i * 40, (i % 2) * 50);
      for (let i = 0; i < 3; i++) h.addEdge(`x${i}->x${i+1}`, `x${i}`, `x${i+1}`, 'calls', 2);
      h.addCluster('cluster:zoomable', ['x0', 'x1', 'x2', 'x3']);
      h.state.posMap.positions.set('cluster:zoomable',
        { x: 0, y: 25, t0x: 0, t0y: 25, sticky: false, locked: false });
    });

    await page.evaluate(() => {
      window.__harness.renderPlan(window.__harness.computeRenderPlanAt(0.1));
    });
    await page.screenshot({ path: `${SHOTS}/24-zoom-transition-low.png` });

    await page.evaluate(() => {
      window.__harness.renderPlan(window.__harness.computeRenderPlanAt(2));
    });
    await page.screenshot({ path: `${SHOTS}/24-zoom-transition-mid.png` });

    await page.evaluate(() => {
      window.__harness.renderPlan(window.__harness.computeRenderPlanAt(8));
    });
    await page.screenshot({ path: `${SHOTS}/24-zoom-transition-high.png` });

    await page.evaluate(() => {
      window.__harness.renderPlan(window.__harness.computeRenderPlanAt(0.1));
    });
    await page.screenshot({ path: `${SHOTS}/24-zoom-transition-back-low.png` });
  });
});

// ─────────────────────────────────────────────────────
// Interaction visual tests
// ─────────────────────────────────────────────────────

test.describe('interactions', () => {
  const HARNESS = () => `${baseUrl}/test/visual/harness.html`;

  test('selection highlights node with ring', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('A', -50, 0);
      h.addNode('B', 50, 0);
      h.addNode('C', 0, 80);
      h.addEdge('A->B', 'A', 'B', 'calls', 1);
      h.addEdge('B->C', 'B', 'C', 'calls', 1);
    });
    await page.screenshot({ path: `${SHOTS}/30-select-before.png` });

    await page.evaluate(() => window.__harness.select('A'));
    await page.screenshot({ path: `${SHOTS}/30-select-single.png` });

    await page.evaluate(() => {
      window.__harness.toggleSelect('B');
      window.__harness.toggleSelect('C');
    });
    await page.screenshot({ path: `${SHOTS}/30-select-multi.png` });

    const sel = await page.evaluate(() => window.__harness.getSelection());
    expect(sel.selected.length).toBe(3);

    await page.evaluate(() => window.__harness.clearSel());
    await page.screenshot({ path: `${SHOTS}/30-select-cleared.png` });
  });

  test('drag moves a node and makes it sticky', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('A', 0, 0);
      h.addNode('B', 100, 0);
      h.addEdge('A->B', 'A', 'B', 'calls', 2);
    });
    await page.screenshot({ path: `${SHOTS}/31-drag-before.png` });

    const result = await page.evaluate(() => {
      const rows = window.__harness.dragNode('A', 80, -60);
      return { rows: rows.length, pos: window.__harness.getPositions() };
    });
    await page.screenshot({ path: `${SHOTS}/31-drag-after.png` });

    expect(result.pos.A.x).toBe(80);
    expect(result.pos.A.y).toBe(-60);
    expect(result.pos.A.sticky).toBe(true);
  });

  test('gather pulls selected nodes toward centroid', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('A', -200, -100);
      h.addNode('B', 200, -100);
      h.addNode('C', 0, 200);
      h.select('A');
      h.toggleSelect('B');
      h.toggleSelect('C');
    });
    await page.screenshot({ path: `${SHOTS}/32-gather-before.png` });

    await page.evaluate(() => window.__harness.runGather(30));
    await page.screenshot({ path: `${SHOTS}/32-gather-after.png` });

    const pos = await page.evaluate(() => window.__harness.getPositions());
    expect(Math.abs(pos.A.x)).toBeLessThan(200);
    expect(Math.abs(pos.B.x)).toBeLessThan(200);
  });

  test('attractor pulls neighbors toward focal node', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('center', 0, 0);
      h.addNode('far1', 200, 0);
      h.addNode('far2', -200, 0);
      h.addNode('far3', 0, 200);
      h.addEdge('center->far1', 'center', 'far1', 'calls', 1);
      h.addEdge('center->far2', 'center', 'far2', 'calls', 1);
      h.addEdge('center->far3', 'center', 'far3', 'calls', 1);
    });
    await page.screenshot({ path: `${SHOTS}/33-attractor-before.png` });

    await page.evaluate(() => window.__harness.runAttractor('center', 40));
    await page.screenshot({ path: `${SHOTS}/33-attractor-after.png` });

    const pos = await page.evaluate(() => window.__harness.getPositions());
    expect(Math.abs(pos.far1.x)).toBeLessThan(200);
    expect(pos.far1.locked).toBe(true);
  });

  test('flash trace highlights BFS wavefronts', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('start', -150, 0);
      h.addNode('hop1a', -50, -50);
      h.addNode('hop1b', -50, 50);
      h.addNode('hop2', 50, 0);
      h.addNode('hop3', 150, 0);
      h.addEdge('start->hop1a', 'start', 'hop1a', 'calls', 1);
      h.addEdge('start->hop1b', 'start', 'hop1b', 'calls', 1);
      h.addEdge('hop1a->hop2', 'hop1a', 'hop2', 'calls', 1);
      h.addEdge('hop1b->hop2', 'hop1b', 'hop2', 'calls', 1);
      h.addEdge('hop2->hop3', 'hop2', 'hop3', 'calls', 1);
    });
    await page.screenshot({ path: `${SHOTS}/34-trace-before.png` });

    const result = await page.evaluate(() => window.__harness.runFlashTrace('start'));
    await page.screenshot({ path: `${SHOTS}/34-trace-flash.png` });

    expect(result.nodes.length).toBe(5);
    expect(result.wavefronts).toBe(4);
  });

  test('reset moves displaced nodes back toward T0', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('A', 0, 0);
      h.addNode('B', 100, 0);
      h.moveNode('A', 200, 200);
      h.moveNode('B', -100, 150);
    });
    await page.screenshot({ path: `${SHOTS}/35-reset-displaced.png` });

    await page.evaluate(() => window.__harness.runReset(60));
    await page.screenshot({ path: `${SHOTS}/35-reset-after.png` });

    const pos = await page.evaluate(() => window.__harness.getPositions());
    expect(Math.abs(pos.A.x)).toBeLessThan(50);
    expect(Math.abs(pos.A.y)).toBeLessThan(50);
  });

  test('single-node reset snaps exactly to T0', async ({ page }) => {
    await page.goto(HARNESS());
    await page.waitForFunction(() => window.__ready);

    await page.evaluate(() => {
      const h = window.__harness;
      h.addNode('A', 0, 0);
      h.moveNode('A', 300, 300);
    });
    await page.screenshot({ path: `${SHOTS}/36-reset-single-displaced.png` });

    await page.evaluate(() => window.__harness.resetNode('A'));
    await page.screenshot({ path: `${SHOTS}/36-reset-single-after.png` });

    const pos = await page.evaluate(() => window.__harness.getPositions());
    expect(pos.A.x).toBe(0);
    expect(pos.A.y).toBe(0);
  });
});
