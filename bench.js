// ========================
// HEADLESS BATCH RUNNER
// ========================
// Spawns N full games of 10 AI agents, in parallel batches, against the same
// /api/decide proxy used by the browser. Each finished game appends a record
// to metrics.jsonl. No rendering, no DOM, no human controller.
//
// Usage:
//   npm run server          # start the LLM proxy on :3001 (in another shell)
//   node bench.js --games=50 --concurrency=3 --speedup=4
//
// Args (all optional):
//   --games=N         total games to run                       (default 1)
//   --concurrency=K   parallel games at once                   (default 1)
//   --speedup=X       sim ticks per realtime tick              (default 4)
//   --maxRealtime=S   hard cap per game in realtime seconds    (default 1200)
//   --impostors=N     impostor count                           (default 2)
//   --pool=cheap|all  model pool to draw from                  (default all)
//
// Notes:
//   - Sim time is decoupled from realtime. Each "tick" advances dt=0.05 sim
//     seconds; we drive the tick at TICK_REALTIME_MS = 50/speedup ms. With
//     speedup=4, a 5-min game runs in ~75s realtime, but LLM calls are still
//     real-time (5-20s), so agents see fewer decision frames in fast mode.
//     For accurate behavior matching the browser, use speedup=1.
//   - Concurrency caps API rate. 10 agents/game × K games = 10K simultaneous
//     in-flight LLM calls. Start conservative; OpenRouter has provider limits.

import { GameState } from './src/game-state.js';
import { Player } from './src/player.js';
import { AgentController } from './src/agent/agent-controller.js';
import { LLMBrain } from './src/agent/llm-brain.js';
import { GameMetrics } from './src/metrics.js';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRICS_PATH = path.join(__dirname, 'metrics.jsonl');
const PROXY_BASE = process.env.PROXY_BASE || 'http://localhost:3001';
const DECIDE_ENDPOINT = `${PROXY_BASE}/api/decide`;

// Keep in sync with src/main.js MODEL_POOL.
const FULL_POOL = [
  { slug: 'anthropic/claude-opus-4.7',      label: 'Claude Opus 4.7' },
  { slug: 'openai/gpt-5.5',                 label: 'GPT-5.5' },
  { slug: 'x-ai/grok-4.3',                  label: 'Grok 4.3' },
  { slug: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
  { slug: 'google/gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro' },
  { slug: 'anthropic/claude-haiku-4.5',     label: 'Claude Haiku 4.5' },
  { slug: 'qwen/qwen3.5-9b',                label: 'Qwen 3.5 9B' },
  { slug: 'moonshotai/kimi-k2.6',           label: 'Kimi K2.6' },
  { slug: 'anthropic/claude-sonnet-4.6',    label: 'Claude Sonnet 4.6' },
  { slug: 'xiaomi/mimo-v2-pro',             label: 'MiMo v2 Pro' },
];

// Cheap pool — drops Opus & GPT-5.5 for smoke-test runs.
const CHEAP_POOL = FULL_POOL.filter(m =>
  !/opus|gpt-5\.5|gemini-3\.1-pro/.test(m.slug));

const NAMES = [
  { name: 'Red',    color: '#c42b3b' },
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

function parseArgs() {
  const a = { games: 1, concurrency: 1, speedup: 4, maxRealtime: 1200, impostors: 2, pool: 'all' };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(\w+)=(.+)$/);
    if (!m) continue;
    const [, k, v] = m;
    a[k] = isNaN(+v) ? v : +v;
  }
  return a;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TOTAL_COST = { usd: 0 };

async function runOneGame(gameIdx, args) {
  const gameCost = { usd: 0, calls: 0 };
  const pool = args.pool === 'cheap' ? CHEAP_POOL : FULL_POOL;
  const game = new GameState();

  // Build the roster (ring-spawn around the Cafeteria table).
  const players = NAMES.map(n => new Player({ name: n.name, color: n.color, spawnRoom: 'Cafeteria' }));
  const CX = 955, CY = 240, R = 95;
  const step = (Math.PI * 2) / players.length;
  for (let i = 0; i < players.length; i++) {
    const a = -Math.PI / 2 + i * step;
    players[i].x = CX + Math.cos(a) * R;
    players[i].y = CY + Math.sin(a) * R;
    players[i].facingLeft = Math.cos(a) > 0;
  }
  for (const p of players) game.addPlayer(p, { update() {} });

  // Random impostor assignment.
  const ids = shuffled(game.players.map(p => p.id)).slice(0, args.impostors);
  game.assignRoles({ impostorIds: ids });
  game.assignTasks({ tasksPerPlayer: 4 });

  // Random model deck.
  const modelDeck = shuffled(pool);
  const modelByName = new Map();
  for (let i = 0; i < game.players.length; i++) {
    modelByName.set(game.players[i].name, modelDeck[i % modelDeck.length]);
  }

  // Wire brains (no human; every seat is an agent).
  for (const p of game.players) {
    const teammates = p.role === 'impostor'
      ? game.players.filter(q => q.role === 'impostor' && q.id !== p.id).map(q => q.name)
      : [];
    const slug = modelByName.get(p.name).slug;
    const brain = new LLMBrain({
      model: slug, name: p.name, role: p.role, color: p.color,
      teammates, endpoint: DECIDE_ENDPOINT, onTrace: () => {},
      onUsage: (u) => {
        const c = Number(u?.cost) || 0;
        gameCost.usd += c;
        gameCost.calls += 1;
        TOTAL_COST.usd += c;
      },
    });
    game.controllers.set(p.id, new AgentController(p, game, brain));
  }

  // Metrics → file append.
  const metrics = new GameMetrics(game, {
    getModelFor: (name) => modelByName.get(name) ?? null,
    submit: async (payload) => {
      payload.gameIdx = gameIdx;
      payload.modelPool = pool.map(m => m.slug);
      await appendFile(METRICS_PATH, JSON.stringify(payload) + '\n', 'utf8');
    },
  });

  const TICK_REALTIME_MS = Math.max(5, Math.round(50 / args.speedup));
  const TICK_DT = 0.05;
  const startedAt = Date.now();
  let lastLog = 0;
  console.log(`[game ${gameIdx}] start. impostors: ${game.players.filter(p => p.role === 'impostor').map(p => p.name).join(', ')}`);

  await new Promise((resolve) => {
    const iv = setInterval(() => {
      try {
        game.tick(TICK_DT);
        metrics.tick();
      } catch (err) {
        console.error(`[game ${gameIdx}] tick threw`, err);
      }
      const realtimeSec = (Date.now() - startedAt) / 1000;
      if (realtimeSec - lastLog >= 30) {
        lastLog = realtimeSec;
        console.log(`[game ${gameIdx}] simT=${game.time.toFixed(0)}s realT=${realtimeSec.toFixed(0)}s phase=${game.phase}`);
      }
      if (game.phase === 'ended') {
        clearInterval(iv);
        resolve();
      } else if (realtimeSec > args.maxRealtime) {
        console.warn(`[game ${gameIdx}] hit max realtime ${args.maxRealtime}s — ending as draw`);
        game.phase = 'ended';
        game.winner = 'draw';
        game.emit({ type: 'game-end', winner: 'draw', reason: 'max-time' });
        metrics.tick();
        clearInterval(iv);
        resolve();
      }
    }, TICK_REALTIME_MS);
  });
  // Wait for the metrics record to actually land in metrics.jsonl before
  // we let this worker pick up the next game — otherwise a crash on a later
  // game could drop the just-finished record.
  await metrics.flushed;
  console.log(`[game ${gameIdx}] done. winner=${game.winner} simT=${game.time.toFixed(1)}s realT=${((Date.now() - startedAt) / 1000).toFixed(1)}s cost=$${gameCost.usd.toFixed(4)} (${gameCost.calls} llm calls)`);
}

async function main() {
  const args = parseArgs();
  console.log('[bench] config:', args);
  console.log('[bench] metrics →', METRICS_PATH);

  // Sanity-check the proxy. Aborting early beats waiting through N timeouts.
  try {
    const r = await fetch(`${PROXY_BASE}/api/health`);
    const j = await r.json();
    if (!j.ok || !j.hasKey) throw new Error('proxy reports no key set');
    console.log('[bench] proxy OK');
  } catch (err) {
    console.error('[bench] proxy unreachable at', PROXY_BASE, '— run `npm run server` first.\n', err.message);
    process.exit(1);
  }

  // Simple concurrency pool: K workers pull game indices off a shared queue.
  const queue = Array.from({ length: args.games }, (_, i) => i);
  const startedAt = Date.now();
  const workers = Array.from({ length: args.concurrency }, async (_, wIdx) => {
    while (queue.length > 0) {
      const idx = queue.shift();
      try { await runOneGame(idx, args); }
      catch (err) { console.error(`[worker ${wIdx}] game ${idx} crashed`, err); }
    }
  });
  await Promise.all(workers);
  console.log(`[bench] ALL DONE. ${args.games} games in ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} min. total cost=$${TOTAL_COST.usd.toFixed(4)} (avg $${(TOTAL_COST.usd / args.games).toFixed(4)}/game)`);
}

main().catch(err => { console.error('[bench] fatal', err); process.exit(1); });
