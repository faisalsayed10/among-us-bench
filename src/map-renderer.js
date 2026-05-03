import {
  rooms, hallways, hallwayStyle, vents, ventConnections, tasks,
  cameras, emergencyButton, doors, shipHull, engineExhausts, MAP_BOUNDS
} from './map-data.js';

// ========================
// COLOR UTILITIES
// ========================

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

function lighten(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + amt, g + amt, b + amt);
}

function darken(hex, amt) {
  return lighten(hex, -amt);
}

// ========================
// FLOOR PATTERN GENERATORS (per-room textures)
// ========================

const patternCache = new Map();

function getPattern(ctx, type, color1, color2) {
  const key = `${type}-${color1}-${color2}`;
  if (patternCache.has(key)) return patternCache.get(key);

  const c = document.createElement('canvas');
  const p = c.getContext('2d');
  let pattern;

  switch (type) {
    case 'checkered': {
      // Cafeteria diamond checkered floor
      c.width = 40; c.height = 40;
      p.fillStyle = color1;
      p.fillRect(0, 0, 40, 40);
      p.fillStyle = color2;
      // Diamond pattern
      p.beginPath();
      p.moveTo(20, 0);
      p.lineTo(40, 20);
      p.lineTo(20, 40);
      p.lineTo(0, 20);
      p.closePath();
      p.fill();
      // Subtle grid lines
      p.strokeStyle = darken(color1, 15);
      p.lineWidth = 0.3;
      p.beginPath();
      p.moveTo(20, 0); p.lineTo(40, 20); p.lineTo(20, 40); p.lineTo(0, 20); p.closePath();
      p.stroke();
      break;
    }
    case 'metal': {
      // Generic metal floor with panel lines
      c.width = 32; c.height = 32;
      p.fillStyle = color1;
      p.fillRect(0, 0, 32, 32);
      p.strokeStyle = lighten(color1, 10);
      p.lineWidth = 0.5;
      p.strokeRect(1, 1, 30, 30);
      // Corner rivets
      p.fillStyle = lighten(color1, 20);
      [[4, 4], [28, 4], [4, 28], [28, 28]].forEach(([x, y]) => {
        p.beginPath(); p.arc(x, y, 1.2, 0, Math.PI * 2); p.fill();
      });
      break;
    }
    case 'tile': {
      // Square tile pattern
      c.width = 28; c.height = 28;
      p.fillStyle = color1;
      p.fillRect(0, 0, 28, 28);
      p.fillStyle = color2;
      p.fillRect(1, 1, 12, 12);
      p.fillRect(15, 15, 12, 12);
      p.strokeStyle = darken(color1, 10);
      p.lineWidth = 0.5;
      p.strokeRect(0, 0, 14, 14);
      p.strokeRect(14, 14, 14, 14);
      break;
    }
    case 'storage_tile': {
      // Yellow/golden large tiles with thick grout
      c.width = 36; c.height = 36;
      p.fillStyle = darken(color1, 15);
      p.fillRect(0, 0, 36, 36);
      p.fillStyle = color1;
      p.fillRect(2, 2, 14, 14);
      p.fillRect(20, 2, 14, 14);
      p.fillRect(2, 20, 14, 14);
      p.fillRect(20, 20, 14, 14);
      // Highlight
      p.fillStyle = lighten(color1, 8);
      p.fillRect(3, 3, 12, 2);
      p.fillRect(21, 3, 12, 2);
      p.fillRect(3, 21, 12, 2);
      p.fillRect(21, 21, 12, 2);
      break;
    }
    case 'carpet': {
      // Admin maroon carpet with subtle weave
      c.width = 16; c.height = 16;
      p.fillStyle = color1;
      p.fillRect(0, 0, 16, 16);
      p.fillStyle = color2;
      for (let y = 0; y < 16; y += 4) {
        for (let x = 0; x < 16; x += 4) {
          p.fillRect(x, y, 2, 2);
        }
      }
      p.fillStyle = lighten(color1, 5);
      for (let y = 2; y < 16; y += 4) {
        for (let x = 2; x < 16; x += 4) {
          p.fillRect(x, y, 2, 2);
        }
      }
      break;
    }
    case 'dirty': {
      // Electrical dirty/grungy floor
      c.width = 32; c.height = 32;
      p.fillStyle = color1;
      p.fillRect(0, 0, 32, 32);
      // Random dirt splotches
      const rng = mulberry32(777);
      p.fillStyle = darken(color1, 10);
      for (let i = 0; i < 8; i++) {
        const x = rng() * 32, y = rng() * 32, r = rng() * 3 + 1;
        p.beginPath(); p.arc(x, y, r, 0, Math.PI * 2); p.fill();
      }
      p.fillStyle = color2;
      for (let i = 0; i < 5; i++) {
        const x = rng() * 32, y = rng() * 32, r = rng() * 2 + 0.5;
        p.beginPath(); p.arc(x, y, r, 0, Math.PI * 2); p.fill();
      }
      break;
    }
    case 'engine': {
      // Engine room - warm metallic with grating
      c.width = 24; c.height = 24;
      p.fillStyle = color1;
      p.fillRect(0, 0, 24, 24);
      p.strokeStyle = lighten(color1, 12);
      p.lineWidth = 0.5;
      for (let i = 0; i < 24; i += 6) {
        p.beginPath(); p.moveTo(0, i); p.lineTo(24, i); p.stroke();
        p.beginPath(); p.moveTo(i, 0); p.lineTo(i, 24); p.stroke();
      }
      p.fillStyle = darken(color1, 8);
      p.fillRect(2, 2, 8, 8);
      p.fillRect(14, 14, 8, 8);
      break;
    }
    case 'reactor': {
      // Reactor purple metallic
      c.width = 28; c.height = 28;
      p.fillStyle = color1;
      p.fillRect(0, 0, 28, 28);
      p.strokeStyle = lighten(color1, 15);
      p.lineWidth = 0.4;
      p.strokeRect(2, 2, 24, 24);
      p.fillStyle = lighten(color1, 8);
      p.fillRect(3, 3, 10, 10);
      p.fillRect(15, 15, 10, 10);
      break;
    }
    case 'medical': {
      // MedBay clean tile floor
      c.width = 30; c.height = 30;
      p.fillStyle = color1;
      p.fillRect(0, 0, 30, 30);
      p.strokeStyle = lighten(color1, 12);
      p.lineWidth = 0.5;
      p.strokeRect(1, 1, 28, 28);
      p.fillStyle = lighten(color1, 6);
      p.fillRect(2, 2, 12, 12);
      p.fillRect(16, 16, 12, 12);
      break;
    }
    case 'hallway': {
      // Hallway metal flooring
      c.width = 24; c.height = 24;
      p.fillStyle = color1;
      p.fillRect(0, 0, 24, 24);
      p.strokeStyle = lighten(color1, 8);
      p.lineWidth = 0.3;
      p.strokeRect(1, 1, 22, 22);
      p.fillStyle = lighten(color1, 4);
      p.fillRect(2, 2, 9, 9);
      p.fillRect(13, 13, 9, 9);
      break;
    }
    default: {
      c.width = 16; c.height = 16;
      p.fillStyle = color1;
      p.fillRect(0, 0, 16, 16);
    }
  }

  pattern = ctx.createPattern(c, 'repeat');
  patternCache.set(key, pattern);
  return pattern;
}

// ========================
// DRAWING HELPERS
// ========================

function drawPolygon(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.closePath();
}

function drawRoundedPolygon(ctx, points, radius) {
  // Draws a polygon with rounded corners
  ctx.beginPath();
  const len = points.length;
  for (let i = 0; i < len; i++) {
    const curr = points[i];
    const next = points[(i + 1) % len];
    const prev = points[(i + len - 1) % len];

    // Direction vectors
    const dx1 = curr[0] - prev[0], dy1 = curr[1] - prev[1];
    const dx2 = next[0] - curr[0], dy2 = next[1] - curr[1];
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

    const r = Math.min(radius, len1 / 2, len2 / 2);

    const startX = curr[0] - (dx1 / len1) * r;
    const startY = curr[1] - (dy1 / len1) * r;
    const endX = curr[0] + (dx2 / len2) * r;
    const endY = curr[1] + (dy2 / len2) * r;

    if (i === 0) ctx.moveTo(startX, startY);
    else ctx.lineTo(startX, startY);

    ctx.quadraticCurveTo(curr[0], curr[1], endX, endY);
  }
  ctx.closePath();
}

// ========================
// SHIP HULL
// ========================

function drawShipHull(ctx) {
  // Outer hull shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetX = 5;
  ctx.shadowOffsetY = 5;

  drawRoundedPolygon(ctx, shipHull, 15);
  ctx.fillStyle = '#2a3238';
  ctx.fill();
  ctx.restore();

  // Hull border
  drawRoundedPolygon(ctx, shipHull, 15);
  ctx.strokeStyle = '#3a4a52';
  ctx.lineWidth = 4;
  ctx.stroke();

  // Inner hull border (lighter)
  drawRoundedPolygon(ctx, shipHull, 15);
  ctx.strokeStyle = '#4a5a62';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Engine exhaust glow
  for (const eng of engineExhausts) {
    const grd = ctx.createRadialGradient(
      eng.x - 15, eng.y + eng.height / 2, 5,
      eng.x - 15, eng.y + eng.height / 2, eng.height * 0.8
    );
    grd.addColorStop(0, 'rgba(100, 220, 255, 0.9)');
    grd.addColorStop(0.3, 'rgba(80, 200, 255, 0.6)');
    grd.addColorStop(0.6, 'rgba(60, 180, 255, 0.3)');
    grd.addColorStop(1, 'rgba(40, 160, 255, 0)');

    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(eng.x - 20, eng.y + eng.height / 2, eng.height * 0.8, eng.height / 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Core bright glow
    const core = ctx.createRadialGradient(
      eng.x - 5, eng.y + eng.height / 2, 2,
      eng.x - 5, eng.y + eng.height / 2, eng.height * 0.3
    );
    core.addColorStop(0, 'rgba(200, 240, 255, 0.95)');
    core.addColorStop(1, 'rgba(100, 220, 255, 0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.ellipse(eng.x - 5, eng.y + eng.height / 2, eng.height * 0.3, eng.height * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ========================
// HALLWAY RENDERING
// ========================

function drawHallways(ctx) {
  const pattern = getPattern(ctx, 'hallway', hallwayStyle.floorColor, darken(hallwayStyle.floorColor, 8));

  for (const hall of hallways) {
    // Floor
    drawPolygon(ctx, hall.polygon);
    ctx.fillStyle = pattern;
    ctx.fill();

    // Tint overlay to match hallway color
    drawPolygon(ctx, hall.polygon);
    ctx.fillStyle = hallwayStyle.floorColor + '80';
    ctx.fill();

    // Wall border
    drawPolygon(ctx, hall.polygon);
    ctx.strokeStyle = hallwayStyle.wallColor;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'miter';
    ctx.stroke();

    // White dashed border (signature Among Us hallway look)
    ctx.save();
    drawPolygon(ctx, hall.polygon);
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = hallwayStyle.dashColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
}

// ========================
// ROOM RENDERING
// ========================

function drawRooms(ctx) {
  for (const room of rooms) {
    ctx.save();

    // Floor with pattern
    const pattern = getPattern(ctx, room.floorType, room.floorColor, room.floorAccent);
    drawPolygon(ctx, room.polygon);
    ctx.fillStyle = pattern;
    ctx.fill();

    // Color tint overlay
    drawPolygon(ctx, room.polygon);
    ctx.fillStyle = room.floorColor + '60';
    ctx.fill();

    // Room walls (thick dark border)
    drawPolygon(ctx, room.polygon);
    ctx.strokeStyle = '#2a3238';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'miter';
    ctx.stroke();

    // Inner wall highlight
    drawPolygon(ctx, room.polygon);
    ctx.strokeStyle = lighten(room.wallColor, 15);
    ctx.lineWidth = 2;
    ctx.stroke();

    // Innermost wall line
    drawPolygon(ctx, room.polygon);
    ctx.strokeStyle = lighten(room.wallColor, 30);
    ctx.lineWidth = 0.5;
    ctx.stroke();

    ctx.restore();

    // Room-specific furniture and details
    drawRoomDetails(ctx, room);
  }
}

// ========================
// ROOM-SPECIFIC DETAILS
// ========================

function drawRoomDetails(ctx, room) {
  ctx.save();
  // Cafeteria-cluster detail functions were authored in the original
  // (pre-shift) coordinate space; shift them by +405 to match the new layout.
  // Other rooms don't have detail functions yet.
  switch (room.name) {
    case 'Cafeteria':
      ctx.translate(405, 0);
      drawCafeteriaDetails(ctx);
      break;
    case 'MedBay':
      ctx.translate(405, 0);
      drawMedBayDetails(ctx);
      break;
    case 'O2':
      ctx.translate(405, 0);
      drawO2Details(ctx);
      break;
    case 'Weapons':
      ctx.translate(405, 0);
      drawWeaponsDetails(ctx);
      break;
    case 'Upper Engine':
      drawEngineDetails(ctx, 345, 240);
      break;
    case 'Lower Engine':
      drawEngineDetails(ctx, 333, 667);
      break;
  }
  ctx.restore();
}

function drawCafeteriaDetails(ctx) {
  // 4 blue round tables in an X arrangement (corners) plus a central
  // emergency-button table. Center of the octagonal room is (550, 240).
  const tablePositions = [
    [470, 145], [630, 145],
    [470, 335], [630, 335],
  ];

  const rx = 38, ry = 28;

  for (const [tx, ty] of tablePositions) {
    // Table shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(tx + 3, ty + 4, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // Table body (Among Us blue)
    ctx.fillStyle = '#2a5a8a';
    ctx.beginPath();
    ctx.ellipse(tx, ty, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // Table rim
    ctx.strokeStyle = '#3a7ab0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(tx, ty, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Table inner highlight
    ctx.fillStyle = '#3a6a98';
    ctx.beginPath();
    ctx.ellipse(tx - 6, ty - 5, 19, 12, 0, 0, Math.PI * 2);
    ctx.fill();

    // Tray details on tables
    ctx.fillStyle = '#e8c840';
    ctx.fillRect(tx + 8, ty - 5, 10, 6);
    ctx.fillStyle = '#c04030';
    ctx.beginPath();
    ctx.arc(tx - 12, ty + 4, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Center emergency-button table (the middle of the X)
  const bx = 550, by = 240;

  // Table-shaped base so it reads as the central table
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(bx + 3, by + 4, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#2a5a8a';
  ctx.beginPath();
  ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a7ab0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Pedestal
  ctx.fillStyle = '#555';
  ctx.beginPath();
  ctx.arc(bx, by, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#444';
  ctx.beginPath();
  ctx.arc(bx, by, 12, 0, Math.PI * 2);
  ctx.fill();
  // Red button
  ctx.fillStyle = '#cc2020';
  ctx.beginPath();
  ctx.arc(bx, by, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ee4040';
  ctx.beginPath();
  ctx.arc(bx - 2, by - 2, 4, 0, Math.PI * 2);
  ctx.fill();
  // "EMERGENCY" text
  ctx.font = 'bold 4px sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText('EMERGENCY', bx, by + 2);
}

function drawReactorDetails(ctx) {
  // Reactor core (large glowing circle)
  const cx = 92, cy = 390;

  // Outer glow
  const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, 45);
  glow.addColorStop(0, 'rgba(80, 120, 255, 0.4)');
  glow.addColorStop(0.5, 'rgba(60, 80, 200, 0.2)');
  glow.addColorStop(1, 'rgba(40, 40, 150, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, 45, 0, Math.PI * 2);
  ctx.fill();

  // Outer ring
  ctx.strokeStyle = '#4060c0';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 28, 0, Math.PI * 2);
  ctx.stroke();

  // Inner core
  ctx.fillStyle = '#2040a0';
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fill();

  // Core bright center
  ctx.fillStyle = '#4080e0';
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.fill();

  // Pulsing bright center
  ctx.fillStyle = '#80c0ff';
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();

  // Pipes from reactor
  ctx.strokeStyle = '#4a3868';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 28);
  ctx.lineTo(cx, cy - 50);
  ctx.moveTo(cx, cy + 28);
  ctx.lineTo(cx, cy + 50);
  ctx.moveTo(cx - 28, cy);
  ctx.lineTo(cx - 40, cy);
  ctx.moveTo(cx + 28, cy);
  ctx.lineTo(cx + 40, cy);
  ctx.stroke();

  // Console panels on sides
  ctx.fillStyle = '#3a2850';
  ctx.fillRect(35, 290, 25, 15);
  ctx.fillRect(35, 470, 25, 15);
  ctx.fillStyle = '#60a0ff';
  ctx.fillRect(38, 293, 8, 4);
  ctx.fillStyle = '#ff6060';
  ctx.fillRect(50, 293, 8, 4);
}

function drawEngineDetails(ctx, cx, cy) {
  // Engine turbine (large circular mechanism)

  // Outer housing
  ctx.fillStyle = '#4a3a32';
  ctx.beginPath();
  ctx.arc(cx, cy, 28, 0, Math.PI * 2);
  ctx.fill();

  // Turbine ring
  ctx.strokeStyle = '#6a8aa0';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 24, 0, Math.PI * 2);
  ctx.stroke();

  // Inner turbine
  ctx.fillStyle = '#3a4a5a';
  ctx.beginPath();
  ctx.arc(cx, cy, 18, 0, Math.PI * 2);
  ctx.fill();

  // Turbine blades
  ctx.strokeStyle = '#6a8a9a';
  ctx.lineWidth = 2;
  for (let a = 0; a < 8; a++) {
    const angle = (a / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * 5, cy + Math.sin(angle) * 5);
    ctx.lineTo(cx + Math.cos(angle) * 16, cy + Math.sin(angle) * 16);
    ctx.stroke();
  }

  // Center bolt
  ctx.fillStyle = '#8aa0b0';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();

  // Fuel gauge nearby
  ctx.fillStyle = '#3a3028';
  ctx.fillRect(cx + 35, cy - 15, 20, 30);
  ctx.fillStyle = '#40a040';
  ctx.fillRect(cx + 38, cy + 5, 14, 8);
  ctx.fillStyle = '#a04040';
  ctx.fillRect(cx + 38, cy - 12, 14, 8);
}

function drawSecurityDetails(ctx) {
  // Security monitor bank
  const mx = 215, my = 325;

  // Monitor desk
  ctx.fillStyle = '#2a3a2a';
  ctx.fillRect(mx - 30, my - 20, 60, 40);

  // Individual monitors (3x2 grid)
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const sx = mx - 24 + c * 18;
      const sy = my - 14 + r * 18;
      ctx.fillStyle = '#102010';
      ctx.fillRect(sx, sy, 14, 12);
      // Screen glow
      ctx.fillStyle = '#204020';
      ctx.fillRect(sx + 1, sy + 1, 12, 10);
      // Scanline effect
      ctx.fillStyle = '#306030';
      ctx.fillRect(sx + 2, sy + 3, 10, 1);
      ctx.fillRect(sx + 2, sy + 7, 10, 1);
    }
  }

  // Chair
  ctx.fillStyle = '#3a3a3a';
  ctx.beginPath();
  ctx.arc(mx, my + 30, 8, 0, Math.PI * 2);
  ctx.fill();
}

function drawMedBayDetails(ctx) {
  // Four horizontal medical beds: 2 against the left wall, 2 against the right.
  // Heads (pillow) press against the side wall; foot end points toward center.
  const bw = 44, bh = 20;
  const beds = [
    { x: 140, y: 334, head: 'left' },
    { x: 140, y: 366, head: 'left' },
    { x: 340 - bw, y: 334, head: 'right' },
    { x: 340 - bw, y: 366, head: 'right' },
  ];

  for (const { x: bx, y: by, head } of beds) {
    // Drop shadow (slightly down/right)
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(bx + 2, by + 3, bw, bh);

    // Frame
    ctx.fillStyle = '#2a3a4a';
    ctx.fillRect(bx, by, bw, bh);

    // Mattress
    ctx.fillStyle = '#4a8ac0';
    ctx.fillRect(bx + 2, by + 2, bw - 4, bh - 4);

    // Top mattress highlight
    ctx.fillStyle = '#6aa8d8';
    ctx.fillRect(bx + 3, by + 3, bw - 6, 3);

    // Pillow + footboard depend on head orientation
    if (head === 'left') {
      // Pillow on left
      ctx.fillStyle = '#f0f4f8';
      ctx.fillRect(bx + 3, by + 4, 12, bh - 8);
      ctx.strokeStyle = '#c8d0d8';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(bx + 3, by + 4, 12, bh - 8);
      // Small red cross on pillow
      ctx.fillStyle = '#e04040';
      ctx.fillRect(bx + 8, by + 7, 2, 6);
      ctx.fillRect(bx + 6, by + 9, 6, 2);
      // Sheet fold line
      ctx.strokeStyle = '#3a78a8';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(bx + 18, by + 4);
      ctx.lineTo(bx + 18, by + bh - 4);
      ctx.stroke();
      // Footboard panel on right
      ctx.fillStyle = '#3a4a5a';
      ctx.fillRect(bx + bw - 5, by + 2, 4, bh - 4);
    } else {
      // Pillow on right
      ctx.fillStyle = '#f0f4f8';
      ctx.fillRect(bx + bw - 15, by + 4, 12, bh - 8);
      ctx.strokeStyle = '#c8d0d8';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(bx + bw - 15, by + 4, 12, bh - 8);
      // Small red cross on pillow
      ctx.fillStyle = '#e04040';
      ctx.fillRect(bx + bw - 10, by + 7, 2, 6);
      ctx.fillRect(bx + bw - 12, by + 9, 6, 2);
      // Sheet fold line
      ctx.strokeStyle = '#3a78a8';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(bx + bw - 18, by + 4);
      ctx.lineTo(bx + bw - 18, by + bh - 4);
      ctx.stroke();
      // Footboard panel on left
      ctx.fillStyle = '#3a4a5a';
      ctx.fillRect(bx + 1, by + 2, 4, bh - 4);
    }
  }

  // Vent below the second (bottom) bed on the left.
  // (The actual vent is rendered by drawVents from map-data; this is the
  // dark wall recess behind it.)
  ctx.fillStyle = '#3a4248';
  ctx.fillRect(150, 403, 30, 18);

  // Scanner setup in the bottom-right corner.
  // Counter/console along the right wall above the scanner pad.
  const consoleX = 295, consoleY = 408;
  ctx.fillStyle = '#3a4a4a';
  ctx.fillRect(consoleX, consoleY, 38, 22);
  ctx.strokeStyle = '#5a7a7a';
  ctx.lineWidth = 1;
  ctx.strokeRect(consoleX, consoleY, 38, 22);
  // Screen
  ctx.fillStyle = '#1a3a4a';
  ctx.fillRect(consoleX + 4, consoleY + 4, 18, 14);
  ctx.fillStyle = '#40b0d0';
  ctx.fillRect(consoleX + 5, consoleY + 5, 16, 3);
  ctx.fillStyle = '#60c890';
  ctx.fillRect(consoleX + 5, consoleY + 11, 10, 2);
  // Indicator buttons
  ctx.fillStyle = '#40c060';
  ctx.beginPath();
  ctx.arc(consoleX + 28, consoleY + 8, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#c04040';
  ctx.beginPath();
  ctx.arc(consoleX + 28, consoleY + 14, 2, 0, Math.PI * 2);
  ctx.fill();

  // Scanner pad (the green-glowing disc on the floor)
  const sx = 300, sy = 465;
  // Outer rim
  ctx.fillStyle = '#7a8a92';
  ctx.beginPath();
  ctx.arc(sx, sy, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#4a5258';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(sx, sy, 22, 0, Math.PI * 2);
  ctx.stroke();
  // Inner pad
  ctx.fillStyle = '#9aaab0';
  ctx.beginPath();
  ctx.arc(sx, sy, 18, 0, Math.PI * 2);
  ctx.fill();
  // Glow
  const padGlow = ctx.createRadialGradient(sx, sy, 2, sx, sy, 16);
  padGlow.addColorStop(0, 'rgba(80, 220, 140, 0.55)');
  padGlow.addColorStop(1, 'rgba(60, 180, 120, 0)');
  ctx.fillStyle = padGlow;
  ctx.beginPath();
  ctx.arc(sx, sy, 16, 0, Math.PI * 2);
  ctx.fill();
  // Footprint outline (where the player stands)
  ctx.strokeStyle = '#40c080';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.arc(sx, sy, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // Scanning crosshair
  ctx.strokeStyle = '#60d0a0';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(sx - 8, sy); ctx.lineTo(sx + 8, sy);
  ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy + 8);
  ctx.stroke();

  // Cable from console to scanner pad
  ctx.strokeStyle = '#2a3a3a';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(consoleX + 8, consoleY + 22);
  ctx.quadraticCurveTo(consoleX + 4, sy - 6, sx + 16, sy - 4);
  ctx.stroke();
}

function drawElectricalDetails(ctx) {
  // Wire panels on north wall
  for (let i = 0; i < 4; i++) {
    const px = 325 + i * 30, py = 400;
    ctx.fillStyle = '#3a3828';
    ctx.fillRect(px, py, 22, 35);
    ctx.strokeStyle = '#4a4838';
    ctx.lineWidth = 1;
    ctx.strokeRect(px, py, 22, 35);
  }

  // Dangling wires
  const wireColors = ['#cc3030', '#30cc30', '#3030cc', '#cccc30'];
  for (let i = 0; i < 4; i++) {
    ctx.strokeStyle = wireColors[i];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const wx = 335 + i * 30;
    ctx.moveTo(wx, 435);
    ctx.quadraticCurveTo(wx + (i % 2 ? 10 : -10), 470, wx + (i % 2 ? -5 : 5), 500);
    ctx.stroke();
  }

  // Main power distributor box
  ctx.fillStyle = '#3a4030';
  ctx.fillRect(440, 420, 30, 50);
  ctx.strokeStyle = '#5a6050';
  ctx.lineWidth = 1;
  ctx.strokeRect(440, 420, 30, 50);
  // Switches
  ctx.fillStyle = '#60a060';
  ctx.fillRect(445, 428, 8, 4);
  ctx.fillRect(445, 436, 8, 4);
  ctx.fillStyle = '#a06060';
  ctx.fillRect(457, 428, 8, 4);
  ctx.fillRect(457, 436, 8, 4);

  // Floor hazard stripes
  ctx.fillStyle = '#ccaa2040';
  ctx.fillRect(315, 515, 160, 10);
}

function drawStorageDetails(ctx) {
  // Green crates (various sizes)
  const crates = [
    [510, 490, 25, 25], [540, 485, 30, 30],
    [505, 520, 20, 20], [575, 510, 28, 22],
    [490, 545, 22, 22],
  ];
  for (const [x, y, w, h] of crates) {
    ctx.fillStyle = '#4a6a4a';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#5a7a5a';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    // Cross straps
    ctx.strokeStyle = '#5a7a5a';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w, y); ctx.lineTo(x, y + h);
    ctx.stroke();
  }

  // Fuel canister
  ctx.fillStyle = '#4a5a70';
  ctx.beginPath();
  ctx.roundRect(620, 530, 15, 25, 4);
  ctx.fill();
  ctx.strokeStyle = '#6a7a90';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(620, 530, 15, 25, 4);
  ctx.stroke();

  // Hazard stripes at bottom
  ctx.save();
  ctx.fillStyle = '#ccaa2060';
  ctx.fillRect(460, 638, 270, 8);
  ctx.restore();
}

function drawAdminDetails(ctx) {
  // Admin map table (the holographic map)
  const ax = 640, ay = 415;

  // Table base
  ctx.fillStyle = '#2a1820';
  ctx.fillRect(ax - 35, ay - 25, 70, 50);
  ctx.strokeStyle = '#5a2838';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(ax - 35, ay - 25, 70, 50);

  // Map screen (green on dark)
  ctx.fillStyle = '#0a2010';
  ctx.fillRect(ax - 30, ay - 20, 60, 40);

  // Mini map shape on screen
  ctx.fillStyle = '#20a040';
  ctx.beginPath();
  // Simplified ship outline
  ctx.ellipse(ax, ay, 22, 14, 0, 0, Math.PI * 2);
  ctx.fill();

  // Blinking dots (players on admin map)
  ctx.fillStyle = '#40ff60';
  const dots = [[ax - 10, ay - 5], [ax + 5, ay + 3], [ax + 15, ay - 2], [ax - 8, ay + 8]];
  for (const [dx, dy] of dots) {
    ctx.beginPath();
    ctx.arc(dx, dy, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ID card reader on wall
  ctx.fillStyle = '#5a4050';
  ctx.fillRect(720, 380, 20, 30);
  ctx.fillStyle = '#206020';
  ctx.fillRect(723, 385, 14, 5);
  ctx.fillStyle = '#40a040';
  ctx.fillRect(723, 395, 14, 2);
}

function drawWeaponsDetails(ctx) {
  // Weapons turret seat (circular targeting station)
  const wx = 940, wy = 245;

  // Seat base
  ctx.fillStyle = '#4a4050';
  ctx.beginPath();
  ctx.arc(wx, wy, 18, 0, Math.PI * 2);
  ctx.fill();

  // Inner targeting ring
  ctx.strokeStyle = '#6a6080';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(wx, wy, 12, 0, Math.PI * 2);
  ctx.stroke();

  // Center
  ctx.fillStyle = '#2a2030';
  ctx.beginPath();
  ctx.arc(wx, wy, 8, 0, Math.PI * 2);
  ctx.fill();

  // Crosshair
  ctx.strokeStyle = '#aa4040';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(wx - 15, wy); ctx.lineTo(wx + 15, wy);
  ctx.moveTo(wx, wy - 15); ctx.lineTo(wx, wy + 15);
  ctx.stroke();

  // Asteroid display (top wall)
  ctx.fillStyle = '#1a1a28';
  ctx.fillRect(910, 158, 60, 18);
  ctx.fillStyle = '#303050';
  ctx.fillRect(912, 160, 56, 14);
  // Stars / asteroids in display
  ctx.fillStyle = '#808090';
  ctx.fillRect(920, 165, 2, 2);
  ctx.fillRect(935, 168, 2, 2);
  ctx.fillRect(950, 163, 2, 2);
  ctx.fillRect(958, 170, 2, 2);
  ctx.fillStyle = '#a04040';
  ctx.fillRect(942, 167, 3, 3);

  // Cannon barrels jutting out of the right wall
  ctx.fillStyle = '#3a2a3a';
  ctx.fillRect(1035, 218, 14, 8);
  ctx.fillRect(1035, 254, 14, 8);
  ctx.strokeStyle = '#5a4858';
  ctx.lineWidth = 1;
  ctx.strokeRect(1035, 218, 14, 8);
  ctx.strokeRect(1035, 254, 14, 8);
  // Cannon tips
  ctx.fillStyle = '#8a4060';
  ctx.fillRect(1047, 219, 3, 6);
  ctx.fillRect(1047, 255, 3, 6);
}

function drawNavigationDetails(ctx) {
  // Large front viewport (the pointed window at the front of the ship)
  const vx = 1020, vy = 390;
  ctx.fillStyle = '#1a2a3a';
  ctx.beginPath();
  ctx.moveTo(vx, vy - 35);
  ctx.lineTo(vx + 35, vy);
  ctx.lineTo(vx, vy + 35);
  ctx.closePath();
  ctx.fill();

  // Stars visible through viewport
  ctx.fillStyle = '#ffffff80';
  const stars = [[vx + 5, vy - 15], [vx + 15, vy + 5], [vx + 10, vy - 5], [vx + 20, vy + 10]];
  for (const [sx, sy] of stars) {
    ctx.beginPath();
    ctx.arc(sx, sy, 1, 0, Math.PI * 2);
    ctx.fill();
  }

  // Steering console
  const cx = 975, cy = 395;
  ctx.fillStyle = '#2a3a4a';
  ctx.fillRect(cx - 25, cy - 12, 50, 28);
  ctx.fillStyle = '#304858';
  ctx.fillRect(cx - 20, cy - 8, 40, 8);
  ctx.fillStyle = '#306888';
  ctx.fillRect(cx - 20, cy + 4, 40, 8);

  // Status lights
  ctx.fillStyle = '#40cc40';
  ctx.beginPath(); ctx.arc(cx - 10, cy - 3, 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#cccc40';
  ctx.beginPath(); ctx.arc(cx, cy - 3, 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#cc4040';
  ctx.beginPath(); ctx.arc(cx + 10, cy - 3, 2, 0, Math.PI * 2); ctx.fill();

  // Navigation map on left wall
  ctx.fillStyle = '#1a2028';
  ctx.fillRect(930, 280, 30, 25);
  ctx.fillStyle = '#203040';
  ctx.fillRect(932, 282, 26, 21);
  // Chart lines
  ctx.strokeStyle = '#405060';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(935, 290); ctx.lineTo(955, 285);
  ctx.moveTo(940, 298); ctx.lineTo(952, 295);
  ctx.stroke();
}

function drawShieldsDetails(ctx) {
  // Shield hexagonal generator
  const sx = 835, sy = 558;

  // Outer ring
  ctx.strokeStyle = '#6060a0';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(sx, sy, 22, 0, Math.PI * 2);
  ctx.stroke();

  // Hexagonal shield shape
  ctx.fillStyle = '#3a3a6a';
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 6;
    const px = sx + Math.cos(a) * 16;
    const py = sy + Math.sin(a) * 16;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#5050a0';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Center glow
  const glow = ctx.createRadialGradient(sx, sy, 2, sx, sy, 12);
  glow.addColorStop(0, 'rgba(100, 100, 200, 0.6)');
  glow.addColorStop(1, 'rgba(60, 60, 150, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(sx, sy, 12, 0, Math.PI * 2);
  ctx.fill();

  // Shield status lights around the outside
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const lx = sx + Math.cos(a) * 28;
    const ly = sy + Math.sin(a) * 28;
    ctx.fillStyle = i < 5 ? '#40a040' : '#a04040';
    ctx.beginPath();
    ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawO2Details(ctx) {
  // Compact O2 fits in the gap between Cafeteria and Weapons (≈140x140 max).
  // Central glass dome with the iconic tree.
  const cx = 790, cy = 320;
  // Base ring
  ctx.fillStyle = '#4a5a58';
  ctx.beginPath();
  ctx.arc(cx, cy, 20, 0, Math.PI * 2);
  ctx.fill();
  // Inner platform
  ctx.fillStyle = '#6a8078';
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI * 2);
  ctx.fill();
  // Glass dome
  ctx.fillStyle = 'rgba(140, 200, 220, 0.45)';
  ctx.beginPath();
  ctx.arc(cx, cy, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#a0c8d0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 14, 0, Math.PI * 2);
  ctx.stroke();
  // Tree trunk
  ctx.fillStyle = '#4a3020';
  ctx.fillRect(cx - 1.5, cy - 2, 3, 9);
  // Foliage
  ctx.fillStyle = '#2a6a3a';
  ctx.beginPath();
  ctx.arc(cx, cy - 4, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a8a4a';
  ctx.beginPath();
  ctx.arc(cx - 3, cy - 6, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 3, cy - 5, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Two small canisters along the bottom of the room
  for (let i = 0; i < 2; i++) {
    const tx = 780 + i * 25, ty = 390;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(tx + 1, ty + 9, 8, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4a6070';
    ctx.beginPath();
    ctx.arc(tx, ty, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6a8090';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(tx, ty, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#2a3848';
    ctx.beginPath();
    ctx.arc(tx, ty, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#80b8d0';
    ctx.beginPath();
    ctx.arc(tx, ty, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Small potted plant tucked into the diagonal corner
  const px = 778, py = 305;
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(px - 3, py + 1, 6, 5);
  ctx.fillStyle = '#3a8a4a';
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5aa560';
  ctx.beginPath();
  ctx.arc(px - 1, py - 1, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawCommsDetails(ctx) {
  // Communications console
  ctx.fillStyle = '#2a3a3a';
  ctx.fillRect(555, 680, 55, 28);
  ctx.fillStyle = '#304848';
  ctx.fillRect(558, 683, 20, 10);
  ctx.fillStyle = '#484830';
  ctx.fillRect(582, 683, 20, 10);

  // Radio equipment
  ctx.fillStyle = '#3a3a4a';
  ctx.fillRect(540, 660, 20, 25);
  ctx.fillStyle = '#cc4040';
  ctx.beginPath();
  ctx.arc(550, 670, 3, 0, Math.PI * 2);
  ctx.fill();

  // Antenna
  ctx.strokeStyle = '#6a6a7a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(550, 660);
  ctx.lineTo(548, 648);
  ctx.lineTo(552, 648);
  ctx.stroke();
}

// ========================
// VENTS
// ========================

function drawVents(ctx) {
  for (const v of vents) {
    // Vent housing
    ctx.fillStyle = '#22282c';
    ctx.fillRect(v.x - 12, v.y - 8, 24, 16);
    ctx.strokeStyle = '#4a5560';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(v.x - 12, v.y - 8, 24, 16);

    // Grate slats
    ctx.strokeStyle = '#3a4248';
    ctx.lineWidth = 1;
    for (let i = -5; i <= 5; i += 2.5) {
      ctx.beginPath();
      ctx.moveTo(v.x - 9, v.y + i);
      ctx.lineTo(v.x + 9, v.y + i);
      ctx.stroke();
    }
  }
}

// Vent connection lines
function drawVentConnections(ctx) {
  const ventById = {};
  for (const v of vents) ventById[v.id] = v;

  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#cc333366';
  ctx.lineWidth = 1.5;

  for (const group of ventConnections) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = ventById[group[i]];
        const b = ventById[group[j]];
        if (a && b) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
  }
  ctx.restore();
}

// ========================
// TASKS, CAMERAS, DOORS
// ========================

function drawTasks(ctx) {
  for (const task of tasks) {
    const r = 4;
    let color;
    if (task.type === 'wiring') color = '#e8c840';
    else if (task.type === 'common') color = '#e88040';
    else color = '#40c8e8';

    // Glow
    ctx.fillStyle = color + '30';
    ctx.beginPath();
    ctx.arc(task.x, task.y, r + 4, 0, Math.PI * 2);
    ctx.fill();

    // Circle
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(task.x, task.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Border
    ctx.strokeStyle = '#ffffff80';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(task.x, task.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawCameras(ctx) {
  for (const cam of cameras) {
    // Camera body
    ctx.fillStyle = '#aa2020';
    ctx.beginPath();
    ctx.arc(cam.x, cam.y, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Blinking glow
    ctx.fillStyle = '#ff404050';
    ctx.beginPath();
    ctx.arc(cam.x, cam.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawDoors(ctx) {
  for (const door of doors) {
    ctx.fillStyle = '#5a6a72';
    if (door.horizontal) {
      ctx.fillRect(door.x - 15, door.y - 3, 30, 6);
    } else {
      ctx.fillRect(door.x - 3, door.y - 15, 6, 30);
    }
  }
}

// ========================
// ROOM LABELS
// ========================

function drawLabels(ctx) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const room of rooms) {
    if (!room.label) continue;
    const [lx, ly] = room.label;

    // Shadow
    ctx.font = 'bold 13px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillText(room.name.toUpperCase(), lx + 1, ly + 1);

    // Main text
    ctx.fillStyle = '#e0e0e5';
    ctx.fillText(room.name.toUpperCase(), lx, ly);
  }
}

// ========================
// LEGEND
// ========================

function drawLegend(ctx) {
  const lx = MAP_BOUNDS.x + MAP_BOUNDS.width - 175;
  const ly = 22;

  ctx.fillStyle = 'rgba(15, 20, 25, 0.85)';
  ctx.beginPath();
  ctx.roundRect(lx - 12, ly - 8, 180, 110, 6);
  ctx.fill();
  ctx.strokeStyle = '#4a5a62';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(lx - 12, ly - 8, 180, 110, 6);
  ctx.stroke();

  ctx.font = 'bold 9px "Segoe UI", sans-serif';
  ctx.fillStyle = '#c0c0c5';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('THE SKELD', lx, ly + 3);

  ctx.font = '8px "Segoe UI", sans-serif';
  const items = [
    ['#4a5560', 'Vents', 'rect'],
    ['#cc3333', 'Vent Connections', 'dash'],
    ['#e8c840', 'Wiring Tasks', 'circle'],
    ['#e88040', 'Common Tasks', 'circle'],
    ['#40c8e8', 'Tasks', 'circle'],
    ['#aa2020', 'Security Cameras', 'dot'],
  ];

  items.forEach((item, i) => {
    const iy = ly + 20 + i * 13;
    ctx.fillStyle = item[0];

    if (item[2] === 'rect') {
      ctx.fillRect(lx, iy - 4, 12, 8);
      ctx.strokeStyle = '#666';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(lx, iy - 4, 12, 8);
    } else if (item[2] === 'circle') {
      ctx.beginPath();
      ctx.arc(lx + 6, iy, 3.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (item[2] === 'dot') {
      ctx.beginPath();
      ctx.arc(lx + 6, iy, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (item[2] === 'dash') {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = item[0];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(lx, iy);
      ctx.lineTo(lx + 12, iy);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = '#b0b0b5';
    ctx.fillText(item[1], lx + 18, iy + 1);
  });
}

// ========================
// BACKGROUND STARS
// ========================

function drawStars(ctx) {
  const rng = mulberry32(42);
  for (let i = 0; i < 200; i++) {
    const sx = MAP_BOUNDS.x + rng() * MAP_BOUNDS.width;
    const sy = MAP_BOUNDS.y + rng() * MAP_BOUNDS.height;
    const sr = rng() * 1.3 + 0.2;
    ctx.globalAlpha = rng() * 0.6 + 0.15;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ========================
// MAIN RENDER
// ========================

export function renderMap(ctx, canvas) {
  // Shift world origin so negative coords render inside the canvas.
  ctx.translate(-MAP_BOUNDS.x, -MAP_BOUNDS.y);

  ctx.clearRect(MAP_BOUNDS.x, MAP_BOUNDS.y, MAP_BOUNDS.width, MAP_BOUNDS.height);

  // Deep space background
  ctx.fillStyle = '#05080c';
  ctx.fillRect(MAP_BOUNDS.x, MAP_BOUNDS.y, MAP_BOUNDS.width, MAP_BOUNDS.height);

  // Stars
  drawStars(ctx);

  // Ship hull (behind everything)
  drawShipHull(ctx);

  // Vent connections (under rooms)
  drawVentConnections(ctx);

  // Hallways (between hull and rooms)
  drawHallways(ctx);

  // Rooms
  drawRooms(ctx);

  // Doors
  drawDoors(ctx);

  // Vents (on top of floors)
  drawVents(ctx);

  // Tasks
  drawTasks(ctx);

  // Cameras
  drawCameras(ctx);

  // Room labels (on top of everything)
  drawLabels(ctx);

  // Legend
  drawLegend(ctx);
}

// ========================
// Seeded PRNG
// ========================
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
