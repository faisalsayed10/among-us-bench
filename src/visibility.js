// ========================
// VISIBILITY / WALL OCCLUSION
// ========================
// Walls are extracted from walkable-zone polygons: an edge segment is a wall
// where exactly one side is walkable. Edges at doorways (both sides walkable)
// are skipped, so vision can pass through.

import { isWalkable, getWalkableZones } from './collision.js';

let cachedWalls = null;
let extraWalls = [];

/** Set the dynamic wall list — typically the edges of currently-closed doors. */
export function setExtraWalls(walls) { extraWalls = walls; }

function buildWalls() {
  const zones = getWalkableZones();
  const walls = [];
  const eps = 1.5;
  const step = 4; // sub-sample resolution along each edge

  for (const zone of zones) {
    const poly = zone.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const len = Math.hypot(ex, ey);
      if (len < 0.5) continue;
      const nx = -ey / len, ny = ex / len;
      const N = Math.max(2, Math.ceil(len / step));

      const isWallAt = (k) => {
        const t = k / N;
        const px = a[0] + ex * t;
        const py = a[1] + ey * t;
        const sideA = isWalkable(px + nx * eps, py + ny * eps);
        const sideB = isWalkable(px - nx * eps, py - ny * eps);
        return sideA !== sideB; // exactly one side walkable
      };

      let segStart = -1;
      for (let k = 0; k <= N; k++) {
        const w = isWallAt(k);
        if (w && segStart < 0) segStart = k;
        else if (!w && segStart >= 0) {
          const tS = segStart / N, tE = (k - 1) / N;
          walls.push([a[0] + ex * tS, a[1] + ey * tS, a[0] + ex * tE, a[1] + ey * tE]);
          segStart = -1;
        }
      }
      if (segStart >= 0) {
        const tS = segStart / N;
        walls.push([a[0] + ex * tS, a[1] + ey * tS, b[0], b[1]]);
      }
    }
  }
  return walls;
}

export function getWalls() {
  if (!cachedWalls) cachedWalls = buildWalls();
  // Dynamic walls (closed doors) are appended each query — cheap, and avoids
  // touching the cached static wall list.
  return extraWalls.length ? [...cachedWalls, ...extraWalls] : cachedWalls;
}

function raySegment(ox, oy, dx, dy, x1, y1, x2, y2) {
  const sx = x2 - x1, sy = y2 - y1;
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < 1e-9) return -1;
  const t = ((x1 - ox) * sy - (y1 - oy) * sx) / denom;
  const u = ((x1 - ox) * dy - (y1 - oy) * dx) / denom;
  if (t < 0 || u < 0 || u > 1) return -1;
  return t;
}

/**
 * Compute the visibility polygon from (px, py), clipped to a circular radius.
 * Returns an array of [x, y] points sorted by angle.
 */
export function computeVisibilityPolygon(px, py, radius) {
  const all = getWalls();
  const margin = radius + 30;

  // Cull walls outside the vision range
  const walls = [];
  for (const w of all) {
    const [x1, y1, x2, y2] = w;
    if ((x1 < px - margin && x2 < px - margin) || (x1 > px + margin && x2 > px + margin)) continue;
    if ((y1 < py - margin && y2 < py - margin) || (y1 > py + margin && y2 > py + margin)) continue;
    walls.push(w);
  }

  // Collect angles to cast rays at: each wall endpoint ± epsilon, plus a ring for the radius cap.
  const angles = [];
  const EPS = 0.0003;
  for (const [x1, y1, x2, y2] of walls) {
    const a1 = Math.atan2(y1 - py, x1 - px);
    const a2 = Math.atan2(y2 - py, x2 - px);
    angles.push(a1 - EPS, a1, a1 + EPS, a2 - EPS, a2, a2 + EPS);
  }
  const N = 48;
  for (let i = 0; i < N; i++) angles.push((i / N) * Math.PI * 2 - Math.PI);

  const points = [];
  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let minT = radius;
    for (const [x1, y1, x2, y2] of walls) {
      const t = raySegment(px, py, dx, dy, x1, y1, x2, y2);
      if (t >= 0 && t < minT) minT = t;
    }
    points.push({ angle: a, x: px + dx * minT, y: py + dy * minT });
  }
  points.sort((p, q) => p.angle - q.angle);
  return points.map(p => [p.x, p.y]);
}
