import { renderMap } from './map-renderer.js';
import { MAP_BOUNDS, doors as DOOR_DEFS, vents as VENT_DEFS } from './map-data.js';
import { Player } from './player.js';
import { HumanController } from './controllers.js';
import { AgentController } from './agent/agent-controller.js';
import { LLMBrain } from './agent/llm-brain.js';
import { GameState } from './game-state.js';
import { getWalkableZones } from './collision.js';
import { computeVisibilityPolygon } from './visibility.js';
import { tasksForPlayer } from './tasks.js';
import { MeetingUI } from './meeting-ui.js';
import { ObservabilityPanel } from './observability-panel.js';
import { GameMetrics } from './metrics.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// First-load mode picker — Play vs Spectate. Persists in localStorage.
// Override via ?mode=spectate / ?mode=play in the URL.
await (async function chooseMode() {
  const urlMode = new URLSearchParams(location.search).get('mode');
  if (urlMode === 'play' || urlMode === 'spectate') {
    localStorage.setItem('amongbench_mode', urlMode);
    return;
  }
  if (localStorage.getItem('amongbench_mode')) return;
  const modal = document.getElementById('mode-modal');
  if (!modal) return;
  modal.classList.add('show');
  await new Promise(resolve => {
    document.getElementById('mode-play').addEventListener('click', () => {
      localStorage.setItem('amongbench_mode', 'play'); modal.classList.remove('show'); resolve();
    });
    document.getElementById('mode-spectate').addEventListener('click', () => {
      localStorage.setItem('amongbench_mode', 'spectate'); modal.classList.remove('show'); resolve();
    });
  });
})();

// ========================
// GAME STATE
// ========================

const game = new GameState();

// Human gets a normal color name so agents can't tell them apart from NPCs.
const human = new Player({ name: 'Red', color: '#c42b3b', spawnRoom: 'Cafeteria' });
game.addPlayer(human, new HumanController(human), { local: true });

// Placeholder NPCs — validates multi-player rendering and visibility occlusion.
// Will be swapped for LLM-driven agents.
const npcs = [];
const npcConfigs = [
  { name: 'Blue',   color: '#1d3ce9' },
  { name: 'Green',  color: '#1f8a3a' },
  { name: 'Yellow', color: '#f1c40f' },
  { name: 'Pink',   color: '#ec4fa0' },
  { name: 'Orange', color: '#ef7d2b' },
  { name: 'Purple', color: '#6b2fbb' },
  { name: 'Cyan',   color: '#38d6d6' },
  { name: 'Lime',   color: '#50ef39' },
  { name: 'Black',  color: '#3f474e' },
];
for (const cfg of npcConfigs) {
  const p = new Player({ name: cfg.name, color: cfg.color, spawnRoom: 'Cafeteria' });
  game.addPlayer(p, { update() {} });
  npcs.push(p);
}

// Ring spawn around the emergency-button table so 10 crewmates don't pile on
// the same pixel. Human is placed first (top of the ring), then NPCs clockwise.
const SPAWN_CENTER = { x: 955, y: 240 };
const SPAWN_RADIUS = 95;
{
  const ring = [human, ...npcs];
  const step = (Math.PI * 2) / ring.length;
  const start = -Math.PI / 2; // human at 12 o'clock
  for (let i = 0; i < ring.length; i++) {
    const a = start + i * step;
    ring[i].x = SPAWN_CENTER.x + Math.cos(a) * SPAWN_RADIUS;
    ring[i].y = SPAWN_CENTER.y + Math.sin(a) * SPAWN_RADIUS;
    // Face inward toward the table.
    ring[i].facingLeft = Math.cos(a) > 0;
  }
}

// Spectator mode: human is a roaming ghost, all 9 NPCs play.
const SPECTATE = localStorage.getItem('amongbench_mode') === 'spectate';

const NUM_IMPOSTORS = 2;
function pickImpostors(pool, n) {
  const ids = pool.map(p => p.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, n);
}
const impostorPool = SPECTATE ? npcs : game.players;
const impostorIds = pickImpostors(impostorPool, NUM_IMPOSTORS);
game.assignRoles({ impostorIds });
game.assignTasks({ tasksPerPlayer: 4 });

if (SPECTATE) {
  human.role = 'spectator';
  human.alive = false;
  human.killCooldown = 0;
  game.tasks = game.tasks.filter(t => t.playerId !== human.id);
  // Park the spectator at the cafeteria emergency-button center so the camera
  // frames the room nicely on load. The ghost itself is hidden in the render loop.
  human.x = SPAWN_CENTER.x;
  human.y = SPAWN_CENTER.y;
}

// Log who the impostors are — useful while debugging, hidden from the game UI.
console.log('[setup] impostors:',
  game.players.filter(p => p.role === 'impostor').map(p => p.name).join(', '));

// ========================
// BRAIN SELECTION
// ========================
// Every NPC is driven by an LLMBrain via the local /api/decide proxy.
// Without the proxy running, agents will fail every decide and just stand
// still — the console will log it.
//
// Each NPC is randomly assigned a distinct model from MODEL_POOL. The
// mapping is hidden from agents (they only see character colors/names) but
// surfaced to us via window.__agentModels for the observability panel.

const MODEL_POOL = [
  { slug: 'anthropic/claude-opus-4.7',       label: 'Claude Opus 4.7' },
  { slug: 'openai/gpt-5.5',                  label: 'GPT-5.5' },
  { slug: 'x-ai/grok-4.3',                   label: 'Grok 4.3' },
  { slug: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
  { slug: 'google/gemini-3.1-pro-preview',   label: 'Gemini 3.1 Pro' },
  { slug: 'anthropic/claude-haiku-4.5',      label: 'Claude Haiku 4.5' },
  { slug: 'deepseek/deepseek-v3.2',          label: 'DeepSeek V3.2' },
  { slug: 'qwen/qwen3-max',                  label: 'Qwen3 Max' },
  { slug: 'anthropic/claude-sonnet-4.6',     label: 'Claude Sonnet 4.6' },
  { slug: 'xiaomi/mimo-v2-pro',              label: 'MiMo v2 Pro' },
];

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const modelDeck = shuffled(MODEL_POOL);

// Human-only mapping of character name → model. Never passed to agents.
window.__agentModels = new Map();

// Trace log keyed by player name — read by the observability panel.
window.__agentTraces = new Map();

// ----- Token cost meter ----------------------------------------------------
// Prices in USD per 1M tokens, mirroring OpenRouter. Cached input is 10% of
// list (Anthropic). Unknown models default to a conservative $1 / $5.
const PRICING = {
  'anthropic/claude-opus-4.7':         { in: 5,    out: 25   },
  'openai/gpt-5.5':                    { in: 5,    out: 30   },
  'x-ai/grok-4.3':                     { in: 1.25, out: 2.5  },
  'anthropic/claude-sonnet-4.6':       { in: 3,    out: 15   },
  'anthropic/claude-haiku-4.5':        { in: 1,    out: 5    },
  'google/gemini-3.1-pro-preview':     { in: 2,    out: 12   },
  'mistralai/mistral-medium-3-5':      { in: 1.5,  out: 7.5  },
  'meta-llama/llama-3.3-70b-instruct': { in: 0.07, out: 0.30 },
  'deepseek/deepseek-v3.2':            { in: 0.27, out: 1.10 },
  'qwen/qwen3-max':                    { in: 1.2,  out: 6    },
  'qwen/qwen3.5-9b':                   { in: 0.04, out: 0.15 },
  'moonshotai/kimi-k2.6':              { in: 0.74, out: 3.5  },
  'xiaomi/mimo-v2-pro':                { in: 1,    out: 3    },
};

window.__totalCostUsd = 0;
window.__costByModel = {};

function costOf(model, usage) {
  const p = PRICING[model] || { in: 1, out: 5 };
  const inTotal = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const cached  = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? 0;
  const out     = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const billedIn = Math.max(0, inTotal - cached);
  return (billedIn * p.in + cached * p.in * 0.1 + out * p.out) / 1_000_000;
}

const costMeterEl = document.getElementById('cost-meter');
function updateCostMeter() {
  if (costMeterEl) costMeterEl.textContent = `$${window.__totalCostUsd.toFixed(3)}`;
}

const onTrace = (entry) => {
  const list = window.__agentTraces.get(entry.name) || [];
  list.push(entry);
  if (list.length > 50) list.shift();
  window.__agentTraces.set(entry.name, list);

  if (entry.usage && entry.model) {
    const c = costOf(entry.model, entry.usage);
    window.__totalCostUsd += c;
    window.__costByModel[entry.model] = (window.__costByModel[entry.model] || 0) + c;
    updateCostMeter();
  }
};

(async () => {
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    if (!j?.ok) return;
    if (j.hasKey) {
      console.log('[brains] LLM mode — server has a key configured.');
      return;
    }
    // No server key → user must supply one. Reuse cached key from localStorage.
    const cached = localStorage.getItem('openrouter_key');
    if (cached) {
      window.__openrouterKey = cached;
      console.log('[brains] using OpenRouter key from localStorage');
      return;
    }
    promptForKey();
  } catch {
    console.warn('[brains] proxy not reachable at /api/health — start it with `npm run server`. Agents will idle.');
  }
})();

function promptForKey() {
  const modal = document.getElementById('key-modal');
  const input = document.getElementById('key-input');
  const save = document.getElementById('key-save');
  const err = document.getElementById('key-err');
  if (!modal) return;
  modal.classList.add('show');
  setTimeout(() => input.focus(), 50);

  const submit = () => {
    const v = input.value.trim();
    if (!v.startsWith('sk-or-')) {
      err.textContent = 'That doesn\'t look like an OpenRouter key (expected sk-or-...).';
      return;
    }
    localStorage.setItem('openrouter_key', v);
    window.__openrouterKey = v;
    modal.classList.remove('show');
  };
  save.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

for (let i = 0; i < npcs.length; i++) {
  const p = npcs[i];
  const teammates = p.role === 'impostor'
    ? game.players.filter(q => q.role === 'impostor' && q.id !== p.id).map(q => q.name)
    : [];
  const assigned = modelDeck[i % modelDeck.length];
  window.__agentModels.set(p.name, assigned);
  p.modelLabel = assigned.label;
  const brain = new LLMBrain({
    model: assigned.slug,
    name: p.name,
    role: p.role,
    color: p.color,
    teammates,
    onTrace,
  });
  game.controllers.set(p.id, new AgentController(p, game, brain));
}

// Interact state: E is a "hold" key for task progress and a "press" trigger
// for kill/report. We track held-state here and consult it each tick.
let eHeld = false;

const meetingUI = new MeetingUI(game);
const observabilityPanel = new ObservabilityPanel(game);
const metrics = new GameMetrics(game, {
  getModelFor: (name) => window.__agentModels?.get(name) ?? null,
});

let camera = { x: 0, y: 0, zoom: 1 };
let lastTime = 0;
let currentRoom = 'Cafeteria';
let debugMode = false;

// Pre-render the static map to an offscreen canvas for performance.
let mapCanvas = null;
function ensureMapCache() {
  if (mapCanvas) return;
  mapCanvas = document.createElement('canvas');
  mapCanvas.width = MAP_BOUNDS.width * 2;
  mapCanvas.height = MAP_BOUNDS.height * 2;
  const mctx = mapCanvas.getContext('2d');
  mctx.scale(2, 2);
  renderMap(mctx, { width: MAP_BOUNDS.width, height: MAP_BOUNDS.height });
}

// ========================
// CAMERA — follows the local (human) player
// ========================

function updateCamera() {
  const local = game.getLocalPlayer();
  if (!local) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const targetZoom = Math.min(vw / 700, vh / 540);
  camera.zoom += (targetZoom - camera.zoom) * 0.08;
  const targetX = vw / 2 - local.x * camera.zoom;
  const targetY = vh / 2 - local.y * camera.zoom;
  camera.x += (targetX - camera.x) * 0.1;
  camera.y += (targetY - camera.y) * 0.1;
}

// ========================
// HUD
// ========================

function drawHUD() {
  const local = game.getLocalPlayer();
  const room = local && local.getCurrentRoom();
  if (room) currentRoom = room;

  ctx.save();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  const padding = 16;
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

  ctx.fillStyle = '#40c8e8';
  ctx.beginPath();
  ctx.arc(padding + 14, padding + boxH / 2, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#e0e0e5';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(roomText, padding + 24, padding + boxH / 2);

  ctx.font = '11px "Segoe UI", Arial, sans-serif';
  ctx.fillStyle = 'rgba(180, 190, 200, 0.5)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const local2 = game.getLocalPlayer();
  const sabHint = (local2 && local2.role === 'impostor' && game.phase === 'playing')
    ? (local2.inVent
        ? '  |  6: next vent  7: exit vent'
        : '  |  1: lights  2: reactor  3: o2  4: close door  5: enter vent')
    : '';
  ctx.fillText(`WASD to move  |  E: interact  |  Q: emergency meeting (Cafeteria, once)${sabHint}  |  F3 debug`, padding, window.innerHeight - padding);

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

  const local = game.getLocalPlayer();
  if (local) {
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(local.x, local.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ff0';
    ctx.font = '6px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(local.x)}, ${Math.round(local.y)}`, local.x + 12, local.y - 12);
  }
}

// ========================
// VISION FOG
// ========================

const VISION_FALLOFF_START = 0.5;
const FOG_OPACITY = 0.95;

let cachedPoly = null;
let cachedPolyAt = { x: -9999, y: -9999, r: -1, doors: -1 };

function drawVisionFog() {
  const local = game.getLocalPlayer();
  if (!local) return;
  // Ghosts see the entire map — no fog while spectating.
  if (!local.alive) return;

  // Vision radius depends on current sabotage state + role.
  const VISION_RADIUS = game.getVisionRadius(local);
  const doorCount = game.closedDoorIds().length;

  const dx = local.x - cachedPolyAt.x, dy = local.y - cachedPolyAt.y;
  const invalid = !cachedPoly
    || dx * dx + dy * dy > 1
    || cachedPolyAt.r !== VISION_RADIUS
    || cachedPolyAt.doors !== doorCount;
  if (invalid) {
    cachedPoly = computeVisibilityPolygon(local.x, local.y, VISION_RADIUS);
    cachedPolyAt = { x: local.x, y: local.y, r: VISION_RADIUS, doors: doorCount };
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

  ctx.fillStyle = `rgba(0, 0, 0, ${FOG_OPACITY})`;
  ctx.beginPath();
  ctx.rect(wx, wy, ww, wh);
  ctx.moveTo(polygon[0][0], polygon[0][1]);
  for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i][0], polygon[i][1]);
  ctx.closePath();
  ctx.fill('evenodd');

  const grad = ctx.createRadialGradient(local.x, local.y, 0, local.x, local.y, VISION_RADIUS);
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
// BODY RENDERING
// ========================

function drawBody(ctx, body) {
  ctx.save();
  ctx.translate(body.x, body.y);
  ctx.rotate(Math.PI / 2);

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(2, 0, 14, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Slumped body
  ctx.fillStyle = body.color;
  ctx.beginPath();
  ctx.ellipse(0, 0, 12, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  // Visor
  ctx.fillStyle = '#8ec5e8';
  ctx.beginPath();
  ctx.ellipse(6, -2, 4, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // Bone protrusion — the iconic dead-crewmate detail
  ctx.fillStyle = '#f4f1e6';
  ctx.fillRect(-10, -1, 5, 2);
  ctx.beginPath();
  ctx.arc(-10, 0, 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ========================
// SABOTAGE UI
// ========================

const sabotageBanner   = document.getElementById('sabotage-banner');
const sabotageTitleEl  = document.getElementById('sabotage-title');
const sabotageDetailEl = document.getElementById('sabotage-detail');

function updateSabotageBanner() {
  const s = game.activeSabotage;
  if (!s) {
    sabotageBanner.classList.remove('show');
    return;
  }
  sabotageBanner.classList.add('show');
  if (s.deadline != null) {
    const left = Math.max(0, s.deadline - game.time);
    sabotageTitleEl.innerHTML = `${labelFor(s.type)} <span class="sabotage-countdown">${left.toFixed(1)}s</span>`;
  } else {
    sabotageTitleEl.textContent = labelFor(s.type);
  }
  // Show remaining (unfixed) spots so crewmates know how many places still need work.
  const remaining = s.fixSpots.filter(sp => !sp.completed).map(sp => sp.room);
  sabotageDetailEl.textContent = remaining.length === 0
    ? 'Repaired'
    : `Fix at ${remaining.join(' AND ')}`;
}

function labelFor(type) {
  if (type === 'lights')  return 'LIGHTS OUT';
  if (type === 'reactor') return 'REACTOR MELTDOWN';
  if (type === 'o2')      return 'O2 DEPLETED';
  return type.toUpperCase();
}

function drawVents(ctx) {
  // Subtle floor-grate icon for every vent. Pulsing highlight on vents the
  // local impostor is near or one of their teammates' viable exits.
  const local = game.getLocalPlayer();
  const isImp = local && local.role === 'impostor';
  const nearby = isImp ? game.nearestVent(local.x, local.y, 60) : null;
  const pulse = (Math.sin(game.time * 5) + 1) * 0.5;
  for (const v of VENT_DEFS) {
    const highlighted = isImp && nearby && nearby.id === v.id;
    ctx.save();
    ctx.translate(v.x, v.y);
    // Base grate (3 horizontal slats inside a rounded square).
    ctx.fillStyle = 'rgba(28, 36, 48, 0.92)';
    ctx.strokeStyle = highlighted
      ? `rgba(120, 220, 240, ${0.55 + 0.4 * pulse})`
      : 'rgba(70, 90, 110, 0.7)';
    ctx.lineWidth = highlighted ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(-9, -9, 18, 18, 3);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(90, 110, 140, 0.85)';
    ctx.lineWidth = 1;
    for (let i = -4; i <= 4; i += 4) {
      ctx.beginPath();
      ctx.moveTo(-6, i);
      ctx.lineTo(6, i);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawClosedDoors(ctx) {
  const ids = game.closedDoorIds();
  if (ids.length === 0) return;
  for (const i of ids) {
    const d = DOOR_DEFS[i];
    const long = 50, thick = 14;
    const w = d.horizontal ? long : thick;
    const h = d.horizontal ? thick : long;
    const x = d.x - w / 2, y = d.y - h / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(220, 60, 60, 0.7)';
    ctx.strokeStyle = '#ec6b6b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 3);
    ctx.fill();
    ctx.stroke();
    // Small lock motif in the middle.
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(d.x, d.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawSabotageFixSpots(ctx) {
  const s = game.activeSabotage;
  if (!s) return;
  const pulse = (Math.sin(game.time * 6) + 1) * 0.5;
  for (const sp of s.fixSpots) {
    if (sp.completed) continue; // hide rings on completed spots
    ctx.save();
    ctx.strokeStyle = `rgba(255, 80, 80, ${0.6 + 0.4 * pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 18 + pulse * 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 80, 80, 0.18)';
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 18, 0, Math.PI * 2);
    ctx.fill();
    // Per-spot progress arc (filling clockwise around the ring).
    if (sp.progress > 0) {
      ctx.strokeStyle = '#67e8a3';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 22, -Math.PI / 2, -Math.PI / 2 + sp.progress * Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  // Fix progress bar above the local player while standing on a fix spot.
  const local = game.getLocalPlayer();
  if (local) {
    const nearbySpot = game.nearestSabotageFix(local);
    if (nearbySpot && nearbySpot.progress > 0) {
      const w = 36, h = 4;
      const x = local.x - w / 2, y = local.y - 32;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#ff7878';
      ctx.fillRect(x, y, w * nearbySpot.progress, h);
    }
  }
}

// ========================
// TASK RENDERING (WORLD SPACE)
// ========================

function drawAssignedTaskSpots(ctx) {
  const local = game.getLocalPlayer();
  if (!local) return;
  const mine = tasksForPlayer(game.tasks, local.id);
  const pulse = (Math.sin(game.time * 4) + 1) * 0.5; // 0..1

  for (const t of mine) {
    if (t.completed) continue;
    const { x, y } = t.def;
    ctx.save();
    ctx.strokeStyle = `rgba(255, 220, 80, ${0.55 + 0.35 * pulse})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 14 + pulse * 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 220, 80, 0.15)';
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawLocalTaskProgress(ctx) {
  const local = game.getLocalPlayer();
  if (!local || !local.alive) return;
  const t = game.activeTaskFor(local);
  if (!t || t.progress <= 0) return;

  const w = 36, h = 4;
  const x = local.x - w / 2;
  const y = local.y - 32;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#67e8a3';
  ctx.fillRect(x, y, w * t.progress, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(x, y, w, h);
}

// ========================
// TASK HUD (SCREEN SPACE)
// ========================

function drawTaskListHUD() {
  const local = game.getLocalPlayer();
  if (!local) return;
  const mine = tasksForPlayer(game.tasks, local.id);
  if (mine.length === 0) return;

  ctx.save();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  const padding = 16;
  const lineH = 18;
  const boxW = 220;
  const boxH = 24 + mine.length * lineH + 12;
  // Top-left, tucked under the room badge (badge is 36px tall + 8px gutter).
  const x = padding;
  const y = padding + 36 + 8;

  ctx.fillStyle = 'rgba(10, 15, 20, 0.85)';
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(100, 130, 160, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 8);
  ctx.stroke();

  ctx.fillStyle = '#9fd8ec';
  ctx.font = 'bold 11px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('TASKS', x + 12, y + 8);

  ctx.font = '12px "Segoe UI", Arial, sans-serif';
  for (let i = 0; i < mine.length; i++) {
    const t = mine[i];
    const lineY = y + 26 + i * lineH;
    if (t.completed) {
      ctx.fillStyle = 'rgba(120, 220, 150, 0.65)';
      ctx.fillText(`✓ ${t.def.name} — ${t.def.room}`, x + 12, lineY);
    } else if (t.progress > 0) {
      ctx.fillStyle = '#ffd866';
      ctx.fillText(`• ${t.def.name} — ${t.def.room}`, x + 12, lineY);
    } else {
      ctx.fillStyle = '#d0d6dc';
      ctx.fillText(`• ${t.def.name} — ${t.def.room}`, x + 12, lineY);
    }
  }

  ctx.restore();
}

function drawGlobalTaskBar() {
  if (game.tasks.length === 0) return;
  const progress = game.globalTaskProgress();
  ctx.save();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const w = Math.min(360, window.innerWidth - 320);
  const h = 8;
  const x = (window.innerWidth - w) / 2;
  const y = 20;

  ctx.fillStyle = 'rgba(10, 15, 20, 0.7)';
  ctx.beginPath();
  ctx.roundRect(x - 2, y - 2, w + 4, h + 4, 4);
  ctx.fill();

  ctx.fillStyle = 'rgba(60, 80, 100, 0.6)';
  ctx.fillRect(x, y, w, h);

  ctx.fillStyle = '#67e8a3';
  ctx.fillRect(x, y, w * progress, h);

  ctx.fillStyle = 'rgba(220, 230, 240, 0.7)';
  ctx.font = '10px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`TASKS  ${Math.round(progress * 100)}%`, x + w / 2, y + h + 2);
  ctx.restore();
}

// HTML end-game overlay (richer than the old canvas text — has stats + buttons).
const endgameEl       = document.getElementById('endgame-overlay');
const endgameWinnerEl = document.getElementById('endgame-winner');
const endgameReasonEl = document.getElementById('endgame-reason');
const endgameStatsEl  = document.getElementById('endgame-stats');
const endgameRestart  = document.getElementById('endgame-restart');
if (endgameRestart) endgameRestart.addEventListener('click', () => location.reload());

let _endgameShown = false;
function updateEndgameOverlay() {
  if (game.phase !== 'ended') {
    if (_endgameShown) { endgameEl.classList.add('hidden'); _endgameShown = false; }
    return;
  }
  if (_endgameShown) return;
  _endgameShown = true;

  const winner = game.winner; // 'crewmates' | 'impostors' | 'draw' | null
  const label = winner === 'crewmates' ? 'CREWMATES WIN'
              : winner === 'impostors' ? 'IMPOSTORS WIN'
              : 'DRAW';
  endgameWinnerEl.textContent = label;
  endgameWinnerEl.className = `endgame-winner ${winner === 'crewmates' ? 'crew' : winner === 'impostors' ? 'impostor' : 'draw'}`;

  // Reason: pull from the game-end event if present.
  const endEv = [...game.events].reverse().find(e => e.type === 'game-end');
  endgameReasonEl.textContent = endEv?.reason ? `reason: ${endEv.reason}` : '';

  // Stats: kills, meetings, top deceiver (by witnessFlipsInflicted or kills).
  const totalKills = game.events.filter(e => e.type === 'kill').length;
  const totalMeetings = game.pastMeetings.length;
  const innocentEjections = game.pastMeetings.filter(m => m.ejectedId != null && !m.wasImpostor).length;
  const impostors = game.players.filter(p => p.role === 'impostor');
  const survived = impostors.filter(p => p.alive).map(p => p.name).join(', ') || '—';
  const cost = window.__totalCostUsd.toFixed(3);

  endgameStatsEl.innerHTML = `
    <div class="row"><span class="label">duration</span><span class="val">${game.time.toFixed(0)}s</span></div>
    <div class="row"><span class="label">kills</span><span class="val">${totalKills}</span></div>
    <div class="row"><span class="label">meetings</span><span class="val">${totalMeetings}</span></div>
    <div class="row"><span class="label">innocents ejected</span><span class="val">${innocentEjections}</span></div>
    <div class="row"><span class="label">impostors surviving</span><span class="val">${survived}</span></div>
    <div class="row"><span class="label">openrouter spend</span><span class="val">$${cost}</span></div>
  `;
  endgameEl.classList.remove('hidden');
}

// ========================
// INTERACT HINT + MEETING OVERLAY
// ========================

function drawInteractHint() {
  const local = game.getLocalPlayer();
  if (!local || !local.alive || game.phase !== 'playing') return;

  let label = null;
  let tone = 'red';
  if (game.nearestBody(local)) {
    label = 'E — REPORT BODY';
  } else if (local.role === 'crewmate' && game.nearestSabotageFix(local)) {
    label = 'HOLD E — FIX SABOTAGE';
    tone = 'cyan';
  } else if (local.role === 'impostor' && game.nearestKillable(local)) {
    const target = game.nearestKillable(local);
    label = local.killCooldown > 0
      ? `KILL (${local.killCooldown.toFixed(1)}s)`
      : `E — KILL ${target.name.toUpperCase()}`;
  } else {
    const t = game.activeTaskFor(local);
    if (t) {
      label = `HOLD E — ${t.def.name.toUpperCase()}`;
      tone = 'cyan';
    }
  }
  if (!label) return;

  ctx.save();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.font = 'bold 14px "Segoe UI", Arial, sans-serif';
  const m = ctx.measureText(label);
  const w = m.width + 24, h = 32;
  const x = (window.innerWidth - w) / 2;
  const y = window.innerHeight - 80;
  ctx.fillStyle = 'rgba(15, 10, 10, 0.9)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 6);
  ctx.fill();
  const dimmed = local.killCooldown > 0 && local.role === 'impostor' && !game.nearestBody(local) && !game.activeTaskFor(local);
  const strokeMap = { red: 'rgba(220, 60, 60, 0.9)', cyan: 'rgba(80, 200, 230, 0.9)' };
  ctx.strokeStyle = dimmed ? 'rgba(180,180,180,0.5)' : strokeMap[tone];
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.restore();
}

// ========================
// INPUT
// ========================

window.addEventListener('keydown', (e) => {
  // Don't intercept keys while the user is typing in the chat input.
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (e.key === 'F3') {
    debugMode = !debugMode;
    e.preventDefault();
    return;
  }
  const local = game.getLocalPlayer();
  if (!local) return;
  if ((e.key === 'q' || e.key === 'Q') && game.phase === 'playing' && !local.inVent) {
    game.tryCallMeeting(local);
    e.preventDefault();
    return;
  }
  if ((e.key === 'e' || e.key === 'E') && game.phase === 'playing' && !local.inVent) {
    eHeld = true;
    // Tap-fire actions: report > kill. Tasks + sabotage fixes are hold-driven.
    if (game.nearestBody(local)) {
      game.tryReportBody(local);
    } else if (local.role === 'impostor' && !game.activeTaskFor(local) && !game.nearestSabotageFix(local)) {
      game.tryKill(local);
    }
    e.preventDefault();
  }

  // Number-key shortcuts for the human impostor.
  if (game.phase === 'playing' && local.role === 'impostor') {
    if (e.key === '1') { game.tryStartSabotage(local, 'lights'); e.preventDefault(); }
    else if (e.key === '2') { game.tryStartSabotage(local, 'reactor'); e.preventDefault(); }
    else if (e.key === '3') { game.tryStartSabotage(local, 'o2'); e.preventDefault(); }
    else if (e.key === '4') {
      const id = game.nearestDoor(local.x, local.y, 90);
      if (id != null) game.tryCloseDoor(local, id);
      e.preventDefault();
    }
    // Vents:
    //   5 — enter the nearest vent (if you're standing on one)
    //   6 — while in vent, hop to the next vent in this network
    //   7 — while in vent, exit at the current location
    else if (e.key === '5') {
      if (!local.inVent) {
        const v = game.nearestVent(local.x, local.y);
        if (v) game.enterVent(local, v.id);
      }
      e.preventDefault();
    } else if (e.key === '6') {
      if (local.inVent) {
        const net = game.ventNetworkFor(local.ventId).map(v => v.id);
        if (net.length > 1) {
          const idx = net.indexOf(local.ventId);
          const next = net[(idx + 1) % net.length];
          game.exitVent(local, next);
          // Snapping out then back in keeps the impostor inside the network so
          // they can keep hopping. Re-enter at the new location automatically.
          game.enterVent(local, next);
        }
      }
      e.preventDefault();
    } else if (e.key === '7') {
      if (local.inVent) game.exitVent(local, local.ventId);
      e.preventDefault();
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'e' || e.key === 'E') eHeld = false;
});
window.addEventListener('blur', () => { eHeld = false; });

// ========================
// GAME LOOP
// ========================

function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
  lastTime = timestamp;

  game.tick(dt);

  // Task progress for local player (hold E on assigned task spot).
  const localForTask = game.getLocalPlayer();
  if (localForTask && localForTask.alive && eHeld && game.phase === 'playing') {
    const active = game.activeTaskFor(localForTask);
    if (active) game.advanceTask(localForTask, active, dt);
    // Sabotage fix: crewmates can hold E at a fix spot.
    if (localForTask.role === 'crewmate' && game.nearestSabotageFix(localForTask)) {
      game.advanceFixSabotage(localForTask, dt);
    }
  }

  updateCamera();

  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;

  ctx.save();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  ctx.fillStyle = '#05080c';
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  ensureMapCache();
  ctx.drawImage(mapCanvas, MAP_BOUNDS.x || 0, MAP_BOUNDS.y || 0, MAP_BOUNDS.width, MAP_BOUNDS.height);

  drawDebugOverlay(ctx);

  // Highlight the local player's assigned task spots so they know where to go.
  drawAssignedTaskSpots(ctx);
  drawSabotageFixSpots(ctx);
  drawVents(ctx);
  drawClosedDoors(ctx);

  // Bodies first, then living players (depth-sorted), so corpses sit under feet.
  for (const b of game.bodies) drawBody(ctx, b);
  // In-vent players are hidden from the canvas — only the impostor themselves
  // knows where they are (and their own client could optionally render them).
  const sorted = [...game.players].filter(p => p.alive && !p.inVent).sort((a, b) => a.y - b.y);
  for (const p of sorted) p.draw(ctx);

  // Render the local player as a translucent ghost when dead, so the user
  // can see where they're free-roaming. Other dead players stay invisible.
  const localGhost = game.getLocalPlayer();
  if (localGhost && !localGhost.alive && localGhost.role !== 'spectator') {
    ctx.save();
    ctx.globalAlpha = 0.45;
    localGhost.draw(ctx);
    ctx.restore();
  }

  // Task progress bar floats over the local player while they work.
  drawLocalTaskProgress(ctx);

  ctx.restore();

  drawVisionFog();
  drawHUD();
  drawTaskListHUD();
  drawGlobalTaskBar();
  drawInteractHint();
  updateEndgameOverlay();

  updateSabotageBanner();
  meetingUI.tick();
  observabilityPanel.tick(timestamp);
  metrics.tick();

  requestAnimationFrame(gameLoop);
}

canvas.style.cursor = 'default';
requestAnimationFrame(gameLoop);
