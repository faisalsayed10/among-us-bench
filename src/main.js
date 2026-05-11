import { renderMap } from './map-renderer.js';
import { MAP_BOUNDS } from './map-data.js';
import { Player } from './player.js';
import { getWalkableZones } from './collision.js';
import { computeVisibilityPolygon } from './visibility.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// ========================
// GAME STATE
// ========================

const player = new Player('You', '#c42b3b');
player.bindInput(canvas);

let camera = { x: 0, y: 0, zoom: 1 };
let lastTime = 0;
let currentRoom = 'Cafeteria';
let debugMode = false;

// Pre-render the static map to an offscreen canvas for performance
let mapCanvas = null;

function ensureMapCache() {
  if (mapCanvas) return;
  mapCanvas = document.createElement('canvas');
  mapCanvas.width = MAP_BOUNDS.width * 2; // 2x for detail
  mapCanvas.height = MAP_BOUNDS.height * 2;
  const mctx = mapCanvas.getContext('2d');
  mctx.scale(2, 2);
  renderMap(mctx, { width: MAP_BOUNDS.width, height: MAP_BOUNDS.height });
}

// ========================
// CAMERA
// ========================

function updateCamera() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Zoom level: show ~700px of map width — extra breathing room around the player
  const targetZoom = Math.min(vw / 700, vh / 540);
  camera.zoom += (targetZoom - camera.zoom) * 0.08;

  // Smooth follow player
  const targetX = vw / 2 - player.x * camera.zoom;
  const targetY = vh / 2 - player.y * camera.zoom;

  camera.x += (targetX - camera.x) * 0.1;
  camera.y += (targetY - camera.y) * 0.1;
}

// ========================
// HUD
// ========================

function drawHUD() {
  const room = player.getCurrentRoom();
  if (room) currentRoom = room;

  ctx.save();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  const padding = 16;

  // Room name box
  ctx.font = 'bold 14px "Segoe UI", Arial, sans-serif';
  const roomText = currentRoom || 'Hallway';
  const metrics = ctx.measureText(roomText);
  const boxW = metrics.width + 30;
  const boxH = 36;

  ctx.fillStyle = 'rgba(10, 15, 20, 0.85)';
  ctx.beginPath();
  ctx.roundRect(padding, padding, boxW, boxH, 8);
  ctx.fill();

  ctx.strokeStyle = 'rgba(100, 130, 160, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(padding, padding, boxW, boxH, 8);
  ctx.stroke();

  // Location icon
  ctx.fillStyle = '#40c8e8';
  ctx.beginPath();
  ctx.arc(padding + 14, padding + boxH / 2, 4, 0, Math.PI * 2);
  ctx.fill();

  // Room name
  ctx.fillStyle = '#e0e0e5';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(roomText, padding + 24, padding + boxH / 2);

  // Controls hint
  ctx.font = '11px "Segoe UI", Arial, sans-serif';
  ctx.fillStyle = 'rgba(180, 190, 200, 0.5)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('WASD to move  |  F3 debug', padding, window.innerHeight - padding);

  ctx.restore();
}

// ========================
// DEBUG OVERLAY
// ========================

function drawDebugOverlay(ctx) {
  if (!debugMode) return;

  const zones = getWalkableZones();
  for (const zone of zones) {
    ctx.beginPath();
    ctx.moveTo(zone.polygon[0][0], zone.polygon[0][1]);
    for (let i = 1; i < zone.polygon.length; i++) {
      ctx.lineTo(zone.polygon[i][0], zone.polygon[i][1]);
    }
    ctx.closePath();

    if (zone.type === 'room') {
      ctx.fillStyle = 'rgba(0, 255, 0, 0.12)';
      ctx.strokeStyle = 'rgba(0, 255, 0, 0.4)';
    } else if (zone.type === 'hall') {
      ctx.fillStyle = 'rgba(0, 100, 255, 0.12)';
      ctx.strokeStyle = 'rgba(0, 100, 255, 0.4)';
    } else {
      ctx.fillStyle = 'rgba(255, 255, 0, 0.15)';
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
    }
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Player collision circle
  ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(player.x, player.y, 8, 0, Math.PI * 2);
  ctx.stroke();

  // Coords
  ctx.fillStyle = '#ff0';
  ctx.font = '6px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(player.x)}, ${Math.round(player.y)}`, player.x + 12, player.y - 12);
}

// ========================
// VISION FOG
// ========================
// Among Us-style limited visibility: a soft radial light around the player,
// rest of the screen darkened. Drawn in screen space after the world.

// Vision is a full visibility polygon — bounded by walls — combined with a
// soft radial falloff so distant areas fade out even when line-of-sight is
// open (otherwise vision "leaks" through doorways across the whole ship).
const VISION_RADIUS = 300;
const VISION_FALLOFF_START = 0.5; // fully lit until this fraction of radius
const FOG_OPACITY = 0.95;

let cachedPoly = null;
let cachedPolyAt = { x: -9999, y: -9999 };

function drawVisionFog() {
  // Only recompute the polygon when the player has actually moved — keeps the
  // ray-cast cost off the per-frame hot path.
  const dx = player.x - cachedPolyAt.x, dy = player.y - cachedPolyAt.y;
  if (!cachedPoly || dx * dx + dy * dy > 1) {
    cachedPoly = computeVisibilityPolygon(player.x, player.y, VISION_RADIUS);
    cachedPolyAt = { x: player.x, y: player.y };
  }
  const polygon = cachedPoly;

  ctx.save();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  const wx = -camera.x / camera.zoom;
  const wy = -camera.y / camera.zoom;
  const ww = window.innerWidth / camera.zoom;
  const wh = window.innerHeight / camera.zoom;

  // Outer fog: dark everywhere except inside the visibility polygon.
  ctx.fillStyle = `rgba(0, 0, 0, ${FOG_OPACITY})`;
  ctx.beginPath();
  ctx.rect(wx, wy, ww, wh);
  ctx.moveTo(polygon[0][0], polygon[0][1]);
  for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i][0], polygon[i][1]);
  ctx.closePath();
  ctx.fill('evenodd');

  // Inner falloff: soft radial darkening inside the polygon so vision fades
  // out far from the player even when no walls block it.
  const grad = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, VISION_RADIUS);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(VISION_FALLOFF_START, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(1, `rgba(0, 0, 0, ${FOG_OPACITY})`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(polygon[0][0], polygon[0][1]);
  for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i][0], polygon[i][1]);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// ========================
// DEBUG KEY
// ========================

window.addEventListener('keydown', (e) => {
  if (e.key === 'F3') {
    debugMode = !debugMode;
    e.preventDefault();
  }
});

// ========================
// GAME LOOP
// ========================

function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
  lastTime = timestamp;

  // Update
  player.update(dt);
  updateCamera();

  // Render
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;

  ctx.save();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  // Clear
  ctx.fillStyle = '#05080c';
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  // Apply camera
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  // Draw cached map
  ensureMapCache();
  ctx.drawImage(mapCanvas, MAP_BOUNDS.x || 0, MAP_BOUNDS.y || 0, MAP_BOUNDS.width, MAP_BOUNDS.height);

  // Debug overlay
  drawDebugOverlay(ctx);

  // Draw player
  player.draw(ctx);

  ctx.restore();

  // Vision fog (screen-space radial darkness around player)
  drawVisionFog();

  // Draw HUD
  drawHUD();

  requestAnimationFrame(gameLoop);
}

// ========================
// START
// ========================

canvas.style.cursor = 'default';
requestAnimationFrame(gameLoop);
