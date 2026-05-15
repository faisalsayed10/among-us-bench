// ========================
// PLAYER / CREWMATE
// ========================
// Pure entity: holds position, appearance, and a per-tick movement intent.
// Input/AI logic lives in controllers; the game loop calls update(dt).

import { resolveMovement, getRoomAt, getSpawnPoint } from './collision.js';

export const MOVE_SPEED = 180; // pixels per second

let nextId = 1;

export class Player {
  constructor({ name = 'Player', color = '#c42b3b', spawnRoom = 'Cafeteria' } = {}) {
    const spawn = getSpawnPoint(spawnRoom);
    this.id = nextId++;
    this.x = spawn.x;
    this.y = spawn.y;
    this.name = name;
    this.color = color;
    this.facingLeft = false;
    this.walking = false;
    this.walkFrame = 0;
    this.alive = true;

    // Role: 'crewmate' | 'impostor'. Assigned by GameState at round start.
    this.role = 'crewmate';
    this.killCooldown = 0;     // seconds remaining before impostor can kill again
    this.armedNoTargetTime = 0; // seconds the cooldown has been at 0 without a target nearby
    this.inVent = false;       // hidden inside the vent network (impostors only)
    this.ventId = null;        // vent the player is currently at while inVent

    // Movement intent for this tick (set by controller). Magnitude <= 1.
    this.intent = { dx: 0, dy: 0 };
  }

  setIntent(dx, dy) {
    this.intent.dx = dx;
    this.intent.dy = dy;
  }

  update(dt, neighbors = null) {
    if (this.killCooldown > 0) this.killCooldown = Math.max(0, this.killCooldown - dt);

    let { dx, dy } = this.intent;
    const mag = Math.hypot(dx, dy);
    if (mag < 0.001) {
      this.walking = false;
      return;
    }

    // Normalize so diagonals aren't faster
    if (mag > 1) { dx /= mag; dy /= mag; }

    // Soft separation: nudge away from nearby living players so crewmates
    // don't merge into one blob when pathing to the same goal. Strength is
    // small enough that intent (especially the human's) still dominates.
    if (neighbors) {
      const SEP_R = 22;
      let sx = 0, sy = 0;
      for (const o of neighbors) {
        if (o === this || !o.alive) continue;
        const ox = this.x - o.x, oy = this.y - o.y;
        const d2 = ox * ox + oy * oy;
        if (d2 > 0.01 && d2 < SEP_R * SEP_R) {
          const d = Math.sqrt(d2);
          const k = (SEP_R - d) / SEP_R;
          sx += (ox / d) * k;
          sy += (oy / d) * k;
        }
      }
      if (sx || sy) {
        dx += sx * 0.6;
        dy += sy * 0.6;
        const m = Math.hypot(dx, dy);
        if (m > 1) { dx /= m; dy /= m; }
      }
    }

    if (dx < 0) this.facingLeft = true;
    else if (dx > 0) this.facingLeft = false;

    const nx = this.x + dx * MOVE_SPEED * dt;
    const ny = this.y + dy * MOVE_SPEED * dt;

    // Ghosts pass through walls — matches Among Us spectator movement.
    const result = this.alive
      ? resolveMovement(this.x, this.y, nx, ny)
      : { x: nx, y: ny };
    const moved = Math.hypot(result.x - this.x, result.y - this.y);
    // Animate only when actually moving — otherwise a player held against a
    // wall (or an AI commanded into one) looks like they're running on the spot.
    this.walking = moved > 0.05;
    if (this.walking) this.walkFrame += dt * 8;
    this.x = result.x;
    this.y = result.y;
  }

  getCurrentRoom() {
    return getRoomAt(this.x, this.y);
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);

    if (this.facingLeft) {
      ctx.scale(-1, 1);
    }

    const bob = this.walking ? Math.sin(this.walkFrame) * 1.5 : 0;
    ctx.translate(0, bob);

    this.drawCrewmate(ctx);

    ctx.restore();

    this.drawNameTag(ctx);
  }

  drawCrewmate(ctx) {
    const scale = 0.9;
    ctx.scale(scale, scale);

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 14, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    const legSpread = this.walking ? Math.sin(this.walkFrame) * 3 : 0;
    ctx.fillStyle = darkenColor(this.color, 30);
    ctx.beginPath();
    ctx.roundRect(-7 + legSpread, 6, 6, 9, 2);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(1 - legSpread, 6, 6, 9, 2);
    ctx.fill();

    ctx.fillStyle = darkenColor(this.color, 20);
    ctx.beginPath();
    ctx.roundRect(-14, -6, 5, 12, 2);
    ctx.fill();

    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.moveTo(-8, 8);
    ctx.lineTo(-8, -4);
    ctx.quadraticCurveTo(-8, -14, 0, -16);
    ctx.quadraticCurveTo(8, -14, 8, -4);
    ctx.lineTo(8, 8);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = darkenColor(this.color, 40);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-8, 8);
    ctx.lineTo(-8, -4);
    ctx.quadraticCurveTo(-8, -14, 0, -16);
    ctx.quadraticCurveTo(8, -14, 8, -4);
    ctx.lineTo(8, 8);
    ctx.stroke();

    ctx.fillStyle = '#8ec5e8';
    ctx.beginPath();
    ctx.moveTo(1, -12);
    ctx.quadraticCurveTo(10, -12, 10, -4);
    ctx.quadraticCurveTo(10, 0, 4, 0);
    ctx.lineTo(1, 0);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#b8e0f8';
    ctx.beginPath();
    ctx.ellipse(6, -8, 3, 2, -0.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#5a8aa8';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(1, -12);
    ctx.quadraticCurveTo(10, -12, 10, -4);
    ctx.quadraticCurveTo(10, 0, 4, 0);
    ctx.lineTo(1, 0);
    ctx.stroke();
  }

  drawNameTag(ctx) {
    ctx.save();
    ctx.font = 'bold 8px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const text = this.name;
    const metrics = ctx.measureText(text);
    const tw = metrics.width + 6;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(this.x - tw / 2, this.y - 26, tw, 12, 3);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, this.x, this.y - 15);

    ctx.restore();
  }
}

function darkenColor(hex, amount) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, (n >> 16) - amount);
  const g = Math.max(0, ((n >> 8) & 0xff) - amount);
  const b = Math.max(0, (n & 0xff) - amount);
  return `rgb(${r},${g},${b})`;
}
