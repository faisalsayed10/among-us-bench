// ========================
// COLLISION & SPATIAL SYSTEM
// ========================
// Approach: raw polygons for walkability, COLLISION_RADIUS keeps player off walls.
// At doorways, room & hallway polygons overlap so transitions are seamless.

import { rooms, hallways } from './map-data.js';

const COLLISION_RADIUS = 8;

// ========================
// POLYGON MATH
// ========================

/** Ray-casting point-in-polygon test */
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ========================
// WALKABLE ZONE REGISTRY
// ========================

const walkableZones = [];

// Rooms
for (const room of rooms) {
  walkableZones.push({
    polygon: room.polygon,
    roomName: room.name,
    type: 'room',
  });
}

// Hallways
for (const hall of hallways) {
  walkableZones.push({
    polygon: hall.polygon,
    roomName: null,
    type: 'hall',
  });
}

// Bridge zones at room/hallway junctions where polygon overlap is too narrow
// (typically where a hex/octagon room meets a rectangular corridor and only a
// diagonal vertex pokes into the corridor).
const bridgeZones = [
  // H-Cafe-Left corridor <-> Upper Engine east tip.
  // Hallway ends at x=435; engine's right vertex sits at (445,240) with
  // diagonal edges that pinch the doorway down to ~30px. This bridge widens
  // the junction so the collision circle can pass without snagging.
  [395, 210, 50, 60],
];

for (const [x, y, w, h] of bridgeZones) {
  walkableZones.push({
    polygon: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
    roomName: null,
    type: 'bridge',
  });
}

// ========================
// DYNAMIC BLOCKERS
// ========================
// Runtime rectangles that subtract from walkability — used for closed doors.
// Kept separate from walkableZones so we don't have to invalidate the static
// geometry cache when a door state changes.

let extraBlockers = [];
export function setExtraBlockers(blockers) { extraBlockers = blockers; }

/** True if (x, y) is inside any dynamic blocker (e.g. a closed door). */
export function isBlocked(x, y) {
  for (const b of extraBlockers) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return true;
  }
  return false;
}

// ========================
// PUBLIC API
// ========================

/** Check if a single point is inside any walkable zone, minus dynamic blockers. */
export function isWalkable(x, y) {
  if (isBlocked(x, y)) return false;
  for (const zone of walkableZones) {
    if (pointInPolygon(x, y, zone.polygon)) return true;
  }
  return false;
}

/**
 * Check if a circle (player) can stand at (x, y).
 * Tests 9 sample points around the collision circle.
 */
export function canStandAt(x, y) {
  const r = COLLISION_RADIUS;
  const r7 = r * 0.707;
  const samples = [
    [x, y],
    [x - r, y], [x + r, y],
    [x, y - r], [x, y + r],
    [x - r7, y - r7], [x + r7, y - r7],
    [x - r7, y + r7], [x + r7, y + r7],
  ];
  return samples.every(([sx, sy]) => isWalkable(sx, sy));
}

/**
 * Move from (cx, cy) toward (nx, ny) with collision.
 * Axis-aligned sliding: if blocked diagonally, try each axis alone.
 */
export function resolveMovement(cx, cy, nx, ny) {
  if (canStandAt(nx, ny)) return { x: nx, y: ny };

  const xOk = canStandAt(nx, cy);
  const yOk = canStandAt(cx, ny);
  if (xOk && yOk) {
    return Math.abs(nx - cx) >= Math.abs(ny - cy) ? { x: nx, y: cy } : { x: cx, y: ny };
  }
  if (xOk) return { x: nx, y: cy };
  if (yOk) return { x: cx, y: ny };

  // Diagonal wall: binary-search the furthest fraction of the step that fits.
  // Without this, players lock against 45° walls because neither axis slide
  // can succeed.
  let lo = 0, hi = 1;
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    if (canStandAt(cx + (nx - cx) * mid, cy + (ny - cy) * mid)) lo = mid;
    else hi = mid;
  }
  return { x: cx + (nx - cx) * lo, y: cy + (ny - cy) * lo };
}

/**
 * Get the room name at (x, y), or null if in hallway
 */
export function getRoomAt(x, y) {
  for (const zone of walkableZones) {
    if (zone.roomName && pointInPolygon(x, y, zone.polygon)) {
      return zone.roomName;
    }
  }
  return null;
}

/**
 * Get spawn point for a named room (centroid)
 */
export function getSpawnPoint(roomName) {
  const zone = walkableZones.find(z => z.roomName === roomName && z.type === 'room');
  if (!zone) return { x: 550, y: 150 };
  const cx = zone.polygon.reduce((s, p) => s + p[0], 0) / zone.polygon.length;
  const cy = zone.polygon.reduce((s, p) => s + p[1], 0) / zone.polygon.length;
  return { x: cx, y: cy };
}

/** Get all walkable zones (for debug rendering) */
export function getWalkableZones() {
  return walkableZones;
}
