// ========================
// PLAYER / CREWMATE
// ========================

import { resolveMovement, getRoomAt, getSpawnPoint } from './collision.js';

const MOVE_SPEED = 180; // pixels per second

export class Player {
  constructor(name = 'You', color = '#c42b3b') {
    const spawn = getSpawnPoint('Cafeteria');
    this.x = spawn.x;
    this.y = spawn.y;
    this.name = name;
    this.color = color;
    this.facingLeft = false;
    this.walking = false;
    this.walkFrame = 0;

    // Input state
    this.keys = { w: false, a: false, s: false, d: false };
  }

  update(dt) {
    let dx = 0, dy = 0;
    if (this.keys.a) dx -= 1;
    if (this.keys.d) dx += 1;
    if (this.keys.w) dy -= 1;
    if (this.keys.s) dy += 1;

    this.walking = dx !== 0 || dy !== 0;

    if (!this.walking) return;

    // Normalize diagonal movement
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;

    // Update facing direction
    if (dx < 0) this.facingLeft = true;
    else if (dx > 0) this.facingLeft = false;

    // Walk animation
    this.walkFrame += dt * 8;

    // Desired new position
    const nx = this.x + dx * MOVE_SPEED * dt;
    const ny = this.y + dy * MOVE_SPEED * dt;

    // Resolve collision
    const result = resolveMovement(this.x, this.y, nx, ny);
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

    // Walk bob
    const bob = this.walking ? Math.sin(this.walkFrame) * 1.5 : 0;
    ctx.translate(0, bob);

    this.drawCrewmate(ctx);

    ctx.restore();

    // Name tag above head
    this.drawNameTag(ctx);
  }

  drawCrewmate(ctx) {
    const scale = 0.9;
    ctx.scale(scale, scale);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 14, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Legs (with walk animation)
    const legSpread = this.walking ? Math.sin(this.walkFrame) * 3 : 0;
    ctx.fillStyle = darkenColor(this.color, 30);
    // Left leg
    ctx.beginPath();
    ctx.roundRect(-7 + legSpread, 6, 6, 9, 2);
    ctx.fill();
    // Right leg
    ctx.beginPath();
    ctx.roundRect(1 - legSpread, 6, 6, 9, 2);
    ctx.fill();

    // Backpack (left side = right when not flipped)
    ctx.fillStyle = darkenColor(this.color, 20);
    ctx.beginPath();
    ctx.roundRect(-14, -6, 5, 12, 2);
    ctx.fill();

    // Body
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.moveTo(-8, 8);
    ctx.lineTo(-8, -4);
    ctx.quadraticCurveTo(-8, -14, 0, -16);
    ctx.quadraticCurveTo(8, -14, 8, -4);
    ctx.lineTo(8, 8);
    ctx.closePath();
    ctx.fill();

    // Body outline
    ctx.strokeStyle = darkenColor(this.color, 40);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-8, 8);
    ctx.lineTo(-8, -4);
    ctx.quadraticCurveTo(-8, -14, 0, -16);
    ctx.quadraticCurveTo(8, -14, 8, -4);
    ctx.lineTo(8, 8);
    ctx.stroke();

    // Visor (the iconic glass dome)
    ctx.fillStyle = '#8ec5e8';
    ctx.beginPath();
    ctx.moveTo(1, -12);
    ctx.quadraticCurveTo(10, -12, 10, -4);
    ctx.quadraticCurveTo(10, 0, 4, 0);
    ctx.lineTo(1, 0);
    ctx.closePath();
    ctx.fill();

    // Visor shine
    ctx.fillStyle = '#b8e0f8';
    ctx.beginPath();
    ctx.ellipse(6, -8, 3, 2, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // Visor outline
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

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(this.x - tw / 2, this.y - 26, tw, 12, 3);
    ctx.fill();

    // Text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, this.x, this.y - 15);

    ctx.restore();
  }

  bindInput(canvas) {
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key in this.keys) {
        this.keys[key] = true;
        e.preventDefault();
      }
      // Arrow key support
      if (e.key === 'ArrowLeft') this.keys.a = true;
      if (e.key === 'ArrowRight') this.keys.d = true;
      if (e.key === 'ArrowUp') this.keys.w = true;
      if (e.key === 'ArrowDown') this.keys.s = true;
    });

    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      if (key in this.keys) {
        this.keys[key] = false;
      }
      if (e.key === 'ArrowLeft') this.keys.a = false;
      if (e.key === 'ArrowRight') this.keys.d = false;
      if (e.key === 'ArrowUp') this.keys.w = false;
      if (e.key === 'ArrowDown') this.keys.s = false;
    });

    // Reset keys on blur (prevent stuck keys)
    window.addEventListener('blur', () => {
      this.keys = { w: false, a: false, s: false, d: false };
    });
  }
}

function darkenColor(hex, amount) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, (n >> 16) - amount);
  const g = Math.max(0, ((n >> 8) & 0xff) - amount);
  const b = Math.max(0, (n & 0xff) - amount);
  return `rgb(${r},${g},${b})`;
}
