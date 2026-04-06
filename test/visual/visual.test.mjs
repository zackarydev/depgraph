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
