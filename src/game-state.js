// ========================
// GAME STATE
// ========================
// Central authority for the simulation. Holds the player roster, controllers,
// bodies, an event log, and ticks everything forward. No network layer —
// every actor (human, AI agent) runs in-process.

import { assignTasksToPlayers, findActiveTask, globalProgress, TASK_DURATION } from './tasks.js';
import { computeVisibilityPolygon, setExtraWalls } from './visibility.js';
import { setExtraBlockers, getRoomAt } from './collision.js';
import { doors as DOOR_DEFS, vents as VENT_DEFS, ventConnections as VENT_CONNECTIONS } from './map-data.js';
const TASK_DECAY_RATE = 0.5 / TASK_DURATION; // see TASK_DECAY_FACTOR

// ------------------------
// Door geometry (static)
// ------------------------

/** Rectangle that a closed door occupies (blocks movement). */
function doorRect(d) {
  const w = d.horizontal ? DOOR_LONG_AXIS : DOOR_SHORT_AXIS;
  const h = d.horizontal ? DOOR_SHORT_AXIS : DOOR_LONG_AXIS;
  return { x: d.x - w / 2, y: d.y - h / 2, w, h };
}

/** A single line segment representing the closed door for vision occlusion. */
function doorWallSegment(d) {
  if (d.horizontal) return [d.x - DOOR_LONG_AXIS / 2, d.y, d.x + DOOR_LONG_AXIS / 2, d.y];
  return [d.x, d.y - DOOR_LONG_AXIS / 2, d.x, d.y + DOOR_LONG_AXIS / 2];
}

// Precompute the rooms each door connects. We sample just outside the door
// along its blocking axis and read the room name at each side.
const DOOR_ROOMS = DOOR_DEFS.map(d => {
  const off = 35;
  const probes = d.horizontal ? [[0, -off], [0, +off]] : [[-off, 0], [+off, 0]];
  const rooms = new Set();
  for (const [dx, dy] of probes) {
    const r = getRoomAt(d.x + dx, d.y + dy);
    if (r) rooms.add(r);
  }
  return [...rooms];
});

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

export const KILL_RADIUS = 40;
export const REPORT_RADIUS = 35;
export const KILL_COOLDOWN = 25;             // seconds, post-kill (Among Us default ~30)
export const KILL_COOLDOWN_INITIAL = 10;     // seconds, at round start (Among Us default ~10)
export const KILL_ENGAGEMENT_RADIUS = 160;   // cooldown stays armed while any target is roughly within a room
export const KILL_ARMED_GRACE = 4;           // seconds the armed state survives with no target in range

// Task progress decays at this fraction of fill-rate when nobody is working it.
// A fully-filled task (1.0) thus drains to 0 in roughly TASK_DURATION / DECAY = 8s.
export const TASK_DECAY_FACTOR = 0.5;

// Meeting sub-phase durations (seconds). LLM latency eats into "real" discussion
// time, so these are generous — agents need a few heartbeats to actually
// converse, not just blurt one line each.
export const DISCUSSION_DURATION = 60;
export const VOTING_DURATION = 15;
export const RESULTS_DURATION = 6;
export const MAX_SPEAK_LENGTH = 200;

// Sabotage tuning.
export const SABOTAGE_COOLDOWN = 30;       // seconds between consecutive sabotages
export const FIX_INTERACT_RADIUS = 35;     // how close a crewmate must be to a fix spot
export const NORMAL_VISION_RADIUS = 300;
export const LIGHTS_OUT_VISION_RADIUS = 120;

// Door tuning. Doors block movement and vision when closed; auto-open after
// CLOSED_DURATION seconds, and the same door can't be re-closed until
// REUSE_COOLDOWN seconds after it opened.
export const DOOR_CLOSED_DURATION = 10;
export const DOOR_REUSE_COOLDOWN = 25;
const DOOR_LONG_AXIS = 50;     // door bar length spanning the corridor
const DOOR_SHORT_AXIS = 14;    // door bar thickness across the corridor

// Venting.
export const VENT_INTERACT_RADIUS = 30;   // how close an impostor must be to a vent to use it
export const VENT_TRAVEL_DURATION = 1.2;  // seconds invisible during traversal

// Vent indexes for fast lookup.
const VENT_BY_ID = Object.fromEntries(VENT_DEFS.map(v => [v.id, v]));
function ventNetworkOf(ventId) {
  for (const net of VENT_CONNECTIONS) if (net.includes(ventId)) return net;
  return null;
}

// Lookup of sabotage definitions. fixSpots are points anyone-walking-up-to can
// hold to repair. deadline (s) = how long until the impostors win if unfixed.
// Multi-spot sabotages (O2) require ALL spots to be completed in time.
export const SABOTAGE_DEFS = {
  lights: {
    label: 'LIGHTS OUT',
    fixSpots: [{ x: 645, y: 608, room: 'Electrical' }],
    deadline: null,             // no timer — purely a vision penalty
    fixDuration: 1.5,
  },
  reactor: {
    label: 'REACTOR MELTDOWN',
    fixSpots: [{ x: 140, y: 445, room: 'Reactor' }],
    deadline: 30,
    fixDuration: 2.5,
  },
  o2: {
    label: 'O2 DEPLETED',
    fixSpots: [
      { x: 1207, y: 345, room: 'O2' },
      { x: 1154, y: 517, room: 'Admin' },
    ],
    deadline: 30,
    fixDuration: 2,             // per-spot; both must complete before deadline
  },
};

export class GameState {
  constructor() {
    this.players = [];
    this.controllers = new Map();
    this.localPlayerId = null;
    this.bodies = [];                 // { id, x, y, victimId, color, name, reported }
    this.tasks = [];                  // TaskInstance[] from tasks.js
    this.winner = null;               // 'crewmates' | 'impostors' | null
    this.activeSabotage = null;       // { type, startedAt, deadline?, fixSpots, fixProgress, lastFixedAt, calledBy }
    this.lastSabotageEndedAt = -Infinity;

    // Doors: per-door runtime state. closed[i] = { openAt, lastClosedAt }, else undefined.
    this.doorState = new Array(DOOR_DEFS.length).fill(null).map(() => ({
      closed: false, openAt: -Infinity, lastClosedAt: -Infinity,
    }));
    this.events = [];                 // append-only log; agents will read from this
    this.time = 0;
    this.phase = 'playing';           // playing | meeting | ended
    this.meeting = null;              // { reporterId, bodyId|null, startedAt }
    this._nextBodyId = 1;
    // Cross-round learning: persist meeting outcomes so subsequent meetings
    // know who voted how and who turned out innocent.
    this.pastMeetings = [];           // [{ t, reporterId, ejectedId, wasImpostor, votes: [{voterId, targetId}], transcript }]
    this.meetingButtonUses = new Map(); // playerId → count; emergency button is once per player
  }

  // ------------------------
  // Emergency button
  // ------------------------
  // Cafeteria-anchored button — any alive player may press it once per game
  // to start a meeting with no body.
  tryCallMeeting(caller) {
    if (this.phase !== 'playing') return false;
    if (!caller.alive) return false;
    if (this.activeSabotage) return false;
    if ((this.meetingButtonUses.get(caller.id) || 0) >= 1) return false;
    // Must be inside the cafeteria, near the table.
    const dx = caller.x - 955, dy = caller.y - 240;
    if (dx * dx + dy * dy > 130 * 130) return false;
    if (caller.getCurrentRoom() !== 'Cafeteria') return false;
    this.meetingButtonUses.set(caller.id, (this.meetingButtonUses.get(caller.id) || 0) + 1);
    this.emit({ type: 'emergency-meeting', callerId: caller.id });
    this._startMeeting({ reporterId: caller.id, bodyId: null });
    return true;
  }

  addPlayer(player, controller, { local = false } = {}) {
    this.players.push(player);
    this.controllers.set(player.id, controller);
    if (local) this.localPlayerId = player.id;
    this.emit({ type: 'spawn', playerId: player.id, name: player.name });
    return player;
  }

  getLocalPlayer() {
    return this.players.find(p => p.id === this.localPlayerId) || null;
  }

  // ------------------------
  // Roles
  // ------------------------

  assignRoles({ impostorIds = [] } = {}) {
    const impostorSet = new Set(impostorIds);
    for (const p of this.players) {
      p.role = impostorSet.has(p.id) ? 'impostor' : 'crewmate';
      p.killCooldown = p.role === 'impostor' ? KILL_COOLDOWN_INITIAL : 0;
    }
    this.emit({ type: 'roles-assigned', impostorIds: [...impostorSet] });
  }

  // ------------------------
  // Tasks
  // ------------------------

  assignTasks({ tasksPerPlayer = 4 } = {}) {
    this.tasks = assignTasksToPlayers(this.players, tasksPerPlayer);
    this.emit({ type: 'tasks-assigned', count: this.tasks.length });
  }

  /** Returns this player's nearest in-range, incomplete task (or null). */
  activeTaskFor(player) {
    return findActiveTask(this.tasks, player);
  }

  /**
   * Advance a task's progress. Called each tick while the player holds E
   * and stands on their task. Emits `task-progress-start` / `task-complete`
   * and triggers win-check on full completion.
   */
  advanceTask(player, task, dt) {
    if (this.phase !== 'playing') return;
    if (!task || task.completed || task.playerId !== player.id) return;

    const wasZero = task.progress === 0;
    task.progress = Math.min(1, task.progress + dt / TASK_DURATION);
    task.lastProgressedAt = this.time;

    if (task.fake) {
      // Fake task — looks like work but never completes. Reset to 0 once full
      // so the impostor can keep "doing" it forever. No events emitted: witnesses
      // see the impostor standing at the spot (spatial vulnerability), nothing
      // else. Skip global completion + win check.
      if (task.progress >= 1) task.progress = 0;
      return;
    }

    if (wasZero) {
      this.emit({
        type: 'task-progress-start',
        playerId: player.id,
        taskId: task.id,
        def: task.def,
        witnessIds: this._witnessesAt(task.def.x, task.def.y),
      });
    }
    if (task.progress >= 1 && !task.completed) {
      task.completed = true;
      this.emit({
        type: 'task-complete',
        playerId: player.id,
        taskId: task.id,
        def: task.def,
        witnessIds: this._witnessesAt(task.def.x, task.def.y),
      });
      if (this.tasks.filter(t => !t.fake).every(t => t.completed)) {
        this.phase = 'ended';
        this.winner = 'crewmates';
        this.emit({ type: 'game-end', winner: 'crewmates', reason: 'all-tasks-complete' });
      }
    }
  }

  globalTaskProgress() {
    return globalProgress(this.tasks);
  }

  // ------------------------
  // Proximity helpers
  // ------------------------

  nearestKillable(impostor) {
    if (impostor.inVent) return null; // can't kill from inside a vent
    let best = null, bestD2 = KILL_RADIUS * KILL_RADIUS;
    for (const p of this.players) {
      if (p === impostor || !p.alive || p.role === 'impostor' || p.inVent) continue;
      const d2 = (p.x - impostor.x) ** 2 + (p.y - impostor.y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    return best;
  }

  /** Nearest vent to (x, y) within radius — used for enter-vent affordance. */
  nearestVent(x, y, radius = VENT_INTERACT_RADIUS) {
    let best = null, bestD2 = radius * radius;
    for (const v of VENT_DEFS) {
      const d2 = (v.x - x) ** 2 + (v.y - y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = v; }
    }
    return best;
  }

  /** All vents in the same network as `ventId` (including itself). */
  ventNetworkFor(ventId) {
    const net = ventNetworkOf(ventId);
    return net ? net.map(id => VENT_BY_ID[id]) : [];
  }

  nearestBody(player) {
    let best = null, bestD2 = REPORT_RADIUS * REPORT_RADIUS;
    for (const b of this.bodies) {
      if (b.reported) continue;
      const d2 = (b.x - player.x) ** 2 + (b.y - player.y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = b; }
    }
    return best;
  }

  // ------------------------
  // Actions
  // ------------------------

  tryKill(impostor) {
    if (this.phase !== 'playing') return false;
    if (impostor.role !== 'impostor' || !impostor.alive) return false;
    if (impostor.killCooldown > 0) return false;
    const victim = this.nearestKillable(impostor);
    if (!victim) return false;

    // Teleport killer to victim for the classic snap-to feel.
    impostor.x = victim.x;
    impostor.y = victim.y;

    victim.alive = false;
    victim.setIntent(0, 0);
    impostor.killCooldown = KILL_COOLDOWN;

    const body = {
      id: this._nextBodyId++,
      x: victim.x,
      y: victim.y,
      victimId: victim.id,
      color: victim.color,
      name: victim.name,
      reported: false,
    };
    this.bodies.push(body);

    this.emit({
      type: 'kill',
      killerId: impostor.id,
      victimId: victim.id,
      at: { x: victim.x, y: victim.y },
      witnessIds: this._witnessesAt(victim.x, victim.y),
    });
    this._checkWinConditions();
    return true;
  }

  tryReportBody(reporter) {
    if (this.phase !== 'playing') return false;
    if (!reporter.alive) return false;
    const body = this.nearestBody(reporter);
    if (!body) return false;
    body.reported = true;
    this.emit({ type: 'body-reported', reporterId: reporter.id, bodyId: body.id, victimId: body.victimId });
    this._startMeeting({ reporterId: reporter.id, bodyId: body.id });
    return true;
  }

  // ------------------------
  // Meetings
  // ------------------------
  // Sub-phase machine: discussion (chat only) → voting (cast vote) →
  // results (reveal + ejection) → back to playing (or ended on win-check).

  _startMeeting({ reporterId, bodyId }) {
    this.phase = 'meeting';
    this.meeting = {
      reporterId,
      bodyId: bodyId ?? null,
      startedAt: this.time,
      subPhase: 'discussion',
      subPhaseEndsAt: this.time + DISCUSSION_DURATION,
      transcript: [],
      votes: new Map(),               // voterId → targetId | 'skip'
      ejectedId: null,
      ejectedWasImpostor: false,
    };
    for (const p of this.players) p.setIntent(0, 0);
    // Meetings cancel any active sabotage AND open all doors (matches Among Us).
    if (this.activeSabotage) this._endSabotage('meeting-cancel');
    for (let i = 0; i < this.doorState.length; i++) {
      if (this.doorState[i].closed) this._openDoor(i);
    }

    // Teleport everyone alive back to the cafeteria table — matches Among Us:
    // a meeting interrupts whatever you were doing and assembles the crew.
    // Dead players stay where their body is so witnesses are spatially accurate.
    const cx = 955, cy = 240, r = 95;
    const alive = this.players.filter(p => p.alive);
    const step = (Math.PI * 2) / Math.max(1, alive.length);
    alive.forEach((p, i) => {
      const a = -Math.PI / 2 + i * step;
      p.x = cx + Math.cos(a) * r;
      p.y = cy + Math.sin(a) * r;
      p.facingLeft = Math.cos(a) > 0;
      if (p.inVent) { p.inVent = false; p.ventId = null; }
    });

    this.emit({ type: 'meeting-start', reporterId, bodyId: bodyId ?? null });
  }

  speak(playerId, text) {
    if (this.phase !== 'meeting' || this.meeting.subPhase !== 'discussion') return false;
    const p = this.players.find(pp => pp.id === playerId);
    if (!p || !p.alive) return false;
    const trimmed = String(text || '').trim().slice(0, MAX_SPEAK_LENGTH);
    if (!trimmed) return false;
    this.meeting.transcript.push({
      playerId, name: p.name, color: p.color, text: trimmed, t: this.time,
    });
    this.emit({ type: 'speak', playerId, text: trimmed });
    return true;
  }

  castVote(voterId, targetId) {
    if (this.phase !== 'meeting' || this.meeting.subPhase !== 'voting') return false;
    const voter = this.players.find(p => p.id === voterId);
    if (!voter || !voter.alive) return false;
    if (this.meeting.votes.has(voterId)) return false;            // one vote per player
    if (targetId !== 'skip') {
      const target = this.players.find(p => p.id === targetId);
      if (!target || !target.alive) return false;
    }
    this.meeting.votes.set(voterId, targetId);
    this.emit({ type: 'vote-cast', voterId });                    // target hidden until reveal
    const eligible = this.players.filter(p => p.alive).length;
    if (this.meeting.votes.size >= eligible) {
      this.meeting.subPhaseEndsAt = this.time;                    // everyone voted → end early
    }
    return true;
  }

  _tickMeeting() {
    const m = this.meeting;
    if (this.time < m.subPhaseEndsAt) return;
    if (m.subPhase === 'discussion') {
      m.subPhase = 'voting';
      m.subPhaseEndsAt = this.time + VOTING_DURATION;
      this.emit({ type: 'voting-start' });
    } else if (m.subPhase === 'voting') {
      const ejectedId = this._tallyVotes();
      m.ejectedId = ejectedId;
      if (ejectedId != null) {
        const ej = this.players.find(p => p.id === ejectedId);
        if (ej) {
          m.ejectedWasImpostor = ej.role === 'impostor';
          ej.alive = false;
        }
      }
      m.subPhase = 'results';
      m.subPhaseEndsAt = this.time + RESULTS_DURATION;
      this.emit({ type: 'voting-end', ejectedId, wasImpostor: m.ejectedWasImpostor });
    } else if (m.subPhase === 'results') {
      // Persist the outcome so future meetings can reason about voting history.
      this.pastMeetings.push({
        t: m.startedAt,
        reporterId: m.reporterId,
        ejectedId: m.ejectedId,
        wasImpostor: m.ejectedWasImpostor,
        votes: [...m.votes.entries()].map(([voterId, targetId]) => ({ voterId, targetId })),
        // Keep the chat for post-game analysis / replay. Small payload.
        transcript: m.transcript.map(line => ({
          t: line.t, playerId: line.playerId, name: line.name, text: line.text,
        })),
      });
      this.emit({ type: 'meeting-end', ejectedId: m.ejectedId, wasImpostor: m.ejectedWasImpostor });
      this.phase = 'playing';
      this.meeting = null;
      this._checkWinConditions();
    }
  }

  _tallyVotes() {
    const counts = new Map();
    for (const target of this.meeting.votes.values()) {
      counts.set(target, (counts.get(target) || 0) + 1);
    }
    let max = 0, leaders = [];
    for (const [k, v] of counts) {
      if (v > max) { max = v; leaders = [k]; }
      else if (v === max) leaders.push(k);
    }
    if (leaders.length !== 1 || leaders[0] === 'skip') return null; // tie or skip wins → no ejection
    return leaders[0];
  }

  _checkWinConditions() {
    if (this.phase === 'ended') return;
    const alive = this.players.filter(p => p.alive);
    const impostors = alive.filter(p => p.role === 'impostor').length;
    const crewmates = alive.filter(p => p.role === 'crewmate').length;
    if (impostors === 0) {
      this.phase = 'ended';
      this.winner = 'crewmates';
      this.emit({ type: 'game-end', winner: 'crewmates', reason: 'impostors-eliminated' });
    } else if (impostors >= crewmates) {
      this.phase = 'ended';
      this.winner = 'impostors';
      this.emit({ type: 'game-end', winner: 'impostors', reason: 'parity' });
    }
  }

  // ------------------------
  // Tick
  // ------------------------

  emit(event) {
    event.t = this.time;
    this.events.push(event);
  }

  // ------------------------
  // Sabotage
  // ------------------------

  /** Crewmates lose vision range while lights are out. */
  getVisionRadius(player) {
    if (this.activeSabotage?.type === 'lights' && player.role === 'crewmate') {
      return LIGHTS_OUT_VISION_RADIUS;
    }
    return NORMAL_VISION_RADIUS;
  }

  sabotageCooldownRemaining() {
    return Math.max(0, SABOTAGE_COOLDOWN - (this.time - this.lastSabotageEndedAt));
  }

  tryStartSabotage(impostor, sabotageType) {
    if (this.phase !== 'playing') return false;
    if (!impostor.alive || impostor.role !== 'impostor') return false;
    if (this.activeSabotage) return false;
    if (this.sabotageCooldownRemaining() > 0) return false;
    const def = SABOTAGE_DEFS[sabotageType];
    if (!def) return false;
    this.activeSabotage = {
      type: sabotageType,
      startedAt: this.time,
      deadline: def.deadline ? this.time + def.deadline : null,
      // Per-spot state — multi-spot sabotages (O2) need ALL spots completed.
      fixSpots: def.fixSpots.map(s => ({
        ...s, progress: 0, completed: false, lastFixedAt: -Infinity,
      })),
      calledBy: impostor.id,
    };
    this.emit({
      type: 'sabotage-start',
      sabotageType,
      deadline: this.activeSabotage.deadline,
      calledBy: impostor.id,
    });
    return true;
  }

  /** Nearest fix spot the player is in range of and not already completed, or null. */
  nearestSabotageFix(player) {
    if (!this.activeSabotage || !player.alive) return null;
    let best = null, bestD2 = FIX_INTERACT_RADIUS * FIX_INTERACT_RADIUS;
    for (const s of this.activeSabotage.fixSpots) {
      if (s.completed) continue;
      const d2 = (s.x - player.x) ** 2 + (s.y - player.y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
  }

  /** Advance the fix bar of whichever spot the player is on. Crewmates only. */
  advanceFixSabotage(player, dt) {
    if (!this.activeSabotage) return false;
    if (!player.alive || player.role !== 'crewmate') return false;
    const spot = this.nearestSabotageFix(player);
    if (!spot) return false;
    const def = SABOTAGE_DEFS[this.activeSabotage.type];
    spot.progress = Math.min(1, spot.progress + dt / def.fixDuration);
    spot.lastFixedAt = this.time;
    if (spot.progress >= 1) {
      spot.completed = true;
      this.emit({ type: 'sabotage-spot-fixed', sabotageType: this.activeSabotage.type, byId: player.id, room: spot.room });
      if (this.activeSabotage.fixSpots.every(s => s.completed)) {
        this._endSabotage('fixed', player.id);
      }
    }
    return true;
  }

  _endSabotage(reason, byId = null) {
    if (!this.activeSabotage) return;
    const type = this.activeSabotage.type;
    this.activeSabotage = null;
    this.lastSabotageEndedAt = this.time;
    this.emit({ type: 'sabotage-end', sabotageType: type, reason, byId });
  }

  // ------------------------
  // Doors
  // ------------------------

  /** Static metadata: door positions + which rooms they connect. */
  getDoorDefs() {
    return DOOR_DEFS.map((d, i) => ({ id: i, x: d.x, y: d.y, between: DOOR_ROOMS[i] }));
  }

  /** Indices of doors currently closed. */
  closedDoorIds() {
    const ids = [];
    for (let i = 0; i < this.doorState.length; i++) {
      if (this.doorState[i].closed) ids.push(i);
    }
    return ids;
  }

  tryCloseDoor(impostor, doorId) {
    if (this.phase !== 'playing') return false;
    if (!impostor.alive || impostor.role !== 'impostor') return false;
    const state = this.doorState[doorId];
    if (!state) return false;
    if (state.closed) return false;
    // Reuse cooldown — measured from when the door last fully opened.
    const reopenedAt = state.lastClosedAt + DOOR_CLOSED_DURATION;
    if (this.time < reopenedAt + DOOR_REUSE_COOLDOWN - DOOR_CLOSED_DURATION) {
      // Still cooling down. (Equivalent to: this.time - state.lastClosedAt < DOOR_REUSE_COOLDOWN.)
    }
    if (this.time - state.lastClosedAt < DOOR_REUSE_COOLDOWN) return false;
    state.closed = true;
    state.openAt = this.time + DOOR_CLOSED_DURATION;
    state.lastClosedAt = this.time;
    this._refreshDoorGeometry();
    this.emit({ type: 'door-closed', doorId, by: impostor.id });
    return true;
  }

  _openDoor(doorId) {
    const state = this.doorState[doorId];
    if (!state || !state.closed) return;
    state.closed = false;
    state.openAt = -Infinity;
    this._refreshDoorGeometry();
    this.emit({ type: 'door-opened', doorId });
  }

  _refreshDoorGeometry() {
    const blockers = [];
    const walls = [];
    for (let i = 0; i < this.doorState.length; i++) {
      if (!this.doorState[i].closed) continue;
      blockers.push(doorRect(DOOR_DEFS[i]));
      walls.push(doorWallSegment(DOOR_DEFS[i]));
    }
    setExtraBlockers(blockers);
    setExtraWalls(walls);
  }

  // ------------------------
  // Vents
  // ------------------------

  /**
   * Enter the vent network. Impostor must be standing within VENT_INTERACT_RADIUS
   * of a vent. Sets inVent=true and snaps the player to that vent's position
   * (so anyone watching sees them disappear into it cleanly).
   */
  enterVent(impostor, ventId) {
    if (this.phase !== 'playing') return false;
    if (!impostor.alive || impostor.role !== 'impostor' || impostor.inVent) return false;
    const vent = VENT_BY_ID[ventId];
    if (!vent) return false;
    const d2 = (vent.x - impostor.x) ** 2 + (vent.y - impostor.y) ** 2;
    if (d2 > VENT_INTERACT_RADIUS * VENT_INTERACT_RADIUS) return false;
    // Snap to the vent so the witness check & visual disappearance line up.
    impostor.x = vent.x; impostor.y = vent.y;
    impostor.inVent = true;
    impostor.ventId = ventId;
    impostor.setIntent(0, 0);
    this.emit({
      type: 'vent-enter',
      playerId: impostor.id,
      ventId,
      at: { x: vent.x, y: vent.y },
      witnessIds: this._witnessesAt(vent.x, vent.y),
    });
    return true;
  }

  /**
   * Exit at `targetVentId`, which must be in the SAME network as the vent
   * the impostor entered through. Teleports them to that vent and clears
   * inVent. Witnesses at the exit point see them emerge.
   */
  exitVent(impostor, targetVentId) {
    if (!impostor.inVent) return false;
    const net = ventNetworkOf(impostor.ventId);
    if (!net || !net.includes(targetVentId)) return false;
    const target = VENT_BY_ID[targetVentId];
    if (!target) return false;
    impostor.x = target.x; impostor.y = target.y;
    impostor.inVent = false;
    impostor.ventId = null;
    this.emit({
      type: 'vent-exit',
      playerId: impostor.id,
      ventId: targetVentId,
      at: { x: target.x, y: target.y },
      witnessIds: this._witnessesAt(target.x, target.y),
    });
    return true;
  }

  /** Find the door nearest to (x,y) within `radius`, or null. */
  nearestDoor(x, y, radius = 60) {
    let best = null, bestD2 = radius * radius;
    for (let i = 0; i < DOOR_DEFS.length; i++) {
      const d = DOOR_DEFS[i];
      const dx = d.x - x, dy = d.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    return best;
  }

  /**
   * Snapshot of which living players have line-of-sight to (x, y) right now.
   * Stored on spatial events at emit time — far more accurate than checking
   * proximity-at-observation-time, which can be both false-positive (close
   * now, behind a wall then) and false-negative (saw it then, walked off).
   */
  _witnessesAt(x, y) {
    const ids = [];
    for (const p of this.players) {
      if (!p.alive || p.inVent) continue;       // in-vent players see nothing externally
      const radius = this.getVisionRadius(p);
      const dx = x - p.x, dy = y - p.y;
      if (dx * dx + dy * dy > radius * radius) continue;
      const poly = computeVisibilityPolygon(p.x, p.y, radius);
      if (pointInPolygon(x, y, poly)) ids.push(p.id);
    }
    return ids;
  }

  tick(dt) {
    this.time += dt;
    if (this.phase === 'meeting') {
      // Agents still need to decide (speak/vote); controllers handle this
      // themselves by inspecting phase.
      for (const p of this.players) {
        const c = this.controllers.get(p.id);
        if (c) c.update(dt);
      }
      this._tickMeeting();
      return;
    }
    if (this.phase !== 'playing') return;
    // Dead players don't act, EXCEPT the local human — they get to free-roam
    // as a ghost while spectating. Their controller still ticks so WASD works.
    for (const p of this.players) {
      if (!p.alive && p.id !== this.localPlayerId) continue;
      const c = this.controllers.get(p.id);
      if (c) c.update(dt);
    }
    for (const p of this.players) {
      if (!p.alive && p.id !== this.localPlayerId) continue;
      p.update(dt, this.players);
    }

    // Kill cooldown reset: an armed impostor (cooldown <= 0) re-arms to a full
    // cooldown if NO crewmate has been within engagement range for KILL_ARMED_GRACE
    // seconds. The grace period stops the cooldown from snapping back during
    // brief moments out of LOS (e.g. while pathing through a doorway).
    for (const p of this.players) {
      if (!p.alive || p.role !== 'impostor') continue;
      if (p.killCooldown > 0) { p.armedNoTargetTime = 0; continue; }

      let hasTarget = false;
      for (const q of this.players) {
        if (!q.alive || q.role !== 'crewmate') continue;
        const dx = q.x - p.x, dy = q.y - p.y;
        if (dx * dx + dy * dy <= KILL_ENGAGEMENT_RADIUS * KILL_ENGAGEMENT_RADIUS) {
          hasTarget = true;
          break;
        }
      }

      if (hasTarget) {
        p.armedNoTargetTime = 0;
      } else {
        p.armedNoTargetTime += dt;
        if (p.armedNoTargetTime >= KILL_ARMED_GRACE) {
          p.killCooldown = KILL_COOLDOWN;
          p.armedNoTargetTime = 0;
        }
      }
    }

    // Task progress decay: any in-progress task that hasn't been advanced
    // for >0.1s drains toward 0 at TASK_DECAY_FACTOR of fill speed.
    for (const t of this.tasks) {
      if (t.completed || t.progress <= 0) continue;
      if (this.time - (t.lastProgressedAt ?? -Infinity) > 0.1) {
        t.progress = Math.max(0, t.progress - TASK_DECAY_RATE * dt);
      }
    }

    // Door auto-open.
    for (let i = 0; i < this.doorState.length; i++) {
      const ds = this.doorState[i];
      if (ds.closed && this.time >= ds.openAt) this._openDoor(i);
    }

    // Sabotage: deadline expiry → impostors win; per-spot fix decay if nobody's fixing.
    if (this.activeSabotage) {
      const s = this.activeSabotage;
      if (s.deadline != null && this.time >= s.deadline) {
        const t = s.type;
        this._endSabotage('expired');
        this.phase = 'ended';
        this.winner = 'impostors';
        this.emit({ type: 'game-end', winner: 'impostors', reason: `${t}-meltdown` });
      } else {
        for (const sp of s.fixSpots) {
          if (sp.completed || sp.progress <= 0) continue;
          if (this.time - sp.lastFixedAt > 0.1) {
            sp.progress = Math.max(0, sp.progress - dt * 0.5);
          }
        }
      }
    }
  }
}
