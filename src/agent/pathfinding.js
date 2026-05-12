// ========================
// PATHFINDING
// ========================
// Grid A* over a one-time-sampled walkability bitmap. Centroid-to-centroid
// movement wasn't enough — corridors curve, room exits sit off-center, and
// the straight-line plus wall-slide approach got agents wedged in corners.
//
// We sample the map at CELL pixels, mark each cell passable only if a full
// collision circle fits there (via canStandAt), then A* between cells and
// smooth the result with line-of-sight to avoid the staircase artifacts of
// pure grid output.

import { MAP_BOUNDS } from '../map-data.js';
import { canStandAt, isBlocked } from '../collision.js';

const CELL = 16;          // 16px grid keeps narrow corridors traversable
const COLS = Math.ceil(MAP_BOUNDS.width / CELL);
const ROWS = Math.ceil(MAP_BOUNDS.height / CELL);

let grid = null;          // Uint8Array(COLS*ROWS), 1 = passable

function ensureGrid() {
  if (grid) return;
  grid = new Uint8Array(COLS * ROWS);
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const wx = cx * CELL + CELL / 2;
      const wy = cy * CELL + CELL / 2;
      if (canStandAt(wx, wy)) grid[cy * COLS + cx] = 1;
    }
  }
}

const passable = (cx, cy) => {
  if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return false;
  if (grid[cy * COLS + cx] !== 1) return false;
  // Runtime blockers (closed doors) — must check on every query since they
  // toggle during play; otherwise agents path right through closed doors.
  const wx = cx * CELL + CELL / 2;
  const wy = cy * CELL + CELL / 2;
  return !isBlocked(wx, wy);
};
const worldToCell = (x, y) => ({ cx: Math.floor(x / CELL), cy: Math.floor(y / CELL) });
const cellToWorld = (cx, cy) => ({ x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 });

/** Find the nearest passable cell to (cx, cy) within a small radius. */
function nearestPassable(cx, cy) {
  if (passable(cx, cy)) return { cx, cy };
  for (let r = 1; r <= 6; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (passable(cx + dx, cy + dy)) return { cx: cx + dx, cy: cy + dy };
      }
    }
  }
  return null;
}

// Octile distance — admissible for 8-connected grids.
function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
}

const NEIGHBORS = [
  [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [1, 1, Math.SQRT2],
];

/**
 * Compute a smoothed waypoint path from (sx,sy) to (gx,gy).
 * Returns an array of {x,y} world points to traverse in order, or [] on failure.
 */
export function findPath(sx, sy, gx, gy) {
  ensureGrid();
  let s = worldToCell(sx, sy);
  let g = worldToCell(gx, gy);
  s = nearestPassable(s.cx, s.cy); if (!s) return [];
  g = nearestPassable(g.cx, g.cy); if (!g) return [];

  const startKey = s.cy * COLS + s.cx;
  const goalKey  = g.cy * COLS + g.cx;
  if (startKey === goalKey) return [{ x: gx, y: gy }];

  // Simple priority queue: array of [key, f]; we re-sort lazily. For ~5–10k
  // visited cells this is fine and avoids importing a heap.
  const open = [[startKey, heuristic(s.cx, s.cy, g.cx, g.cy)]];
  const gScore = new Map([[startKey, 0]]);
  const came = new Map();
  const closed = new Set();

  while (open.length) {
    // pop lowest f
    let bestI = 0;
    for (let i = 1; i < open.length; i++) if (open[i][1] < open[bestI][1]) bestI = i;
    const [curKey] = open.splice(bestI, 1)[0];
    if (closed.has(curKey)) continue;
    if (curKey === goalKey) return smoothPath(reconstruct(came, curKey, startKey), gx, gy);
    closed.add(curKey);

    const cx = curKey % COLS;
    const cy = (curKey - cx) / COLS;
    const curG = gScore.get(curKey);

    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cx + dx, ny = cy + dy;
      if (!passable(nx, ny)) continue;
      // Disallow diagonal corner-cutting through a blocked orthogonal cell.
      if (dx !== 0 && dy !== 0 && (!passable(cx + dx, cy) || !passable(cx, cy + dy))) continue;
      const nKey = ny * COLS + nx;
      if (closed.has(nKey)) continue;
      const tentative = curG + cost;
      if (tentative < (gScore.get(nKey) ?? Infinity)) {
        came.set(nKey, curKey);
        gScore.set(nKey, tentative);
        open.push([nKey, tentative + heuristic(nx, ny, g.cx, g.cy)]);
      }
    }
  }
  return [];
}

function reconstruct(came, goalKey, startKey) {
  const cells = [];
  let k = goalKey;
  while (k !== startKey) {
    const cx = k % COLS, cy = (k - cx) / COLS;
    cells.push(cellToWorld(cx, cy));
    k = came.get(k);
    if (k === undefined) break;
  }
  cells.reverse();
  return cells;
}

/** String-pulling: skip waypoints we have direct line-of-walk to. */
function smoothPath(cells, gx, gy) {
  if (cells.length === 0) return [{ x: gx, y: gy }];
  const out = [];
  let anchor = { x: cells[0].x, y: cells[0].y };
  out.push(anchor);
  for (let i = 1; i < cells.length; i++) {
    if (!losClear(anchor, cells[i])) {
      anchor = cells[i - 1];
      out.push(anchor);
    }
  }
  // Replace the last waypoint with the exact goal if reachable.
  const last = out[out.length - 1];
  if (losClear(last, { x: gx, y: gy })) out[out.length - 1] = { x: gx, y: gy };
  else out.push({ x: gx, y: gy });
  return out;
}

function losClear(a, b) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(2, Math.ceil(dist / 6));
  for (let k = 1; k < steps; k++) {
    const t = k / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (!canStandAt(x, y) || isBlocked(x, y)) return false;
  }
  return true;
}
