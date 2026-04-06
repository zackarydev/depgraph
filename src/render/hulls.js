/**
 * Cluster hull rendering: convex hull polygons + expand for padding.
 *
 * Uses a simple convex hull algorithm (Graham scan). In the browser,
 * d3.polygonHull can be used instead. The expand function inflates
 * the hull outward for visual padding.
 *
 * @module render/hulls
 */

/**
 * Compute convex hull points for a cluster from member positions.
 * Pure function — works in Node.js.
 *
 * @param {import('../core/types.js').Cluster} cluster
 * @param {import('../layout/positions.js').PositionMap} posMap
 * @returns {[number, number][]} array of [x, y] hull points
 */
export function computeHull(cluster, posMap) {
  const points = [];
  for (const memberId of cluster.members) {
    const ps = posMap.positions.get(memberId);
    if (ps) points.push([ps.x, ps.y]);
  }

  if (points.length < 3) return points;
  return grahamScan(points);
}

/**
 * Expand a hull outward by a padding distance.
 *
 * @param {[number, number][]} hull
 * @param {number} [padding=20]
 * @returns {[number, number][]}
 */
export function expandHull(hull, padding = 20) {
  if (hull.length < 3) return hull;

  // Find centroid
  let cx = 0, cy = 0;
  for (const [x, y] of hull) { cx += x; cy += y; }
  cx /= hull.length;
  cy /= hull.length;

  // Push each point away from centroid
  return hull.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    return [x + (dx / d) * padding, y + (dy / d) * padding];
  });
}

/**
 * Render cluster hulls in the gHulls SVG layer.
 * Browser-only.
 *
 * @param {Element} gHulls - SVG group
 * @param {Array<{ cluster: import('../core/types.js').Cluster, hull: [number, number][] }>} hullData
 */
export function renderHulls(gHulls, hullData) {
  if (!gHulls || typeof document === 'undefined') return;

  while (gHulls.firstChild) gHulls.removeChild(gHulls.firstChild);

  for (const { cluster, hull } of hullData) {
    if (hull.length < 3) continue;

    const expanded = expandHull(hull);
    const pathData = `M${expanded.map(([x, y]) => `${x},${y}`).join('L')}Z`;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('class', 'hull');
    path.setAttribute('data-cluster', cluster.id);
    path.setAttribute('fill', 'rgba(150, 150, 150, 0.1)');
    path.setAttribute('stroke', '#aaa');
    path.setAttribute('stroke-width', '1');
    gHulls.appendChild(path);
  }
}

// ─── Graham scan convex hull ───

function grahamScan(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  // Remove last point of each half because it's repeated
  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}
