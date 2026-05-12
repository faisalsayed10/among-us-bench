// ========================
// AGENT CONTROLLER
// ========================
// Bridges a Brain to a Player. Each tick:
//   1. If we have no current action OR it's time to re-evaluate, build an
//      observation, call brain.decide(), adopt the returned action.
//   2. Run the action's executor to set the player's per-frame intent and
//      fire any tap-actions (kill / report / etc).
//
// We re-decide every HEARTBEAT seconds (so e.g. an impostor reconsiders when
// a crewmate walks into view) and any time the executor reports `done`.

import { getSpawnPoint } from '../collision.js';
import { TASK_INTERACT_RADIUS } from '../tasks.js';
import { buildObservation } from './observation.js';
import { findPath } from './pathfinding.js';
import { wait } from './schema.js';

const HEARTBEAT = 2.5;             // seconds between decide calls (play phase)
const MAX_IDLE_BEFORE_DECIDE = 10; // safety: always call at least this often even if "nothing" changed
const ARRIVE_RADIUS = 12;
const STUCK_WINDOW = 0.8;
const STUCK_THRESHOLD = 1.0;

export class AgentController {
  /**
   * @param {import('../player.js').Player} player
   * @param {import('../game-state.js').GameState} game
   * @param {import('./schema.js').Brain} brain
   */
  constructor(player, game, brain) {
    this.player = player;
    this.game = game;
    this.brain = brain;
    this.scratchpad = {};
    this.action = null;
    this.exec = null;
    this.timeSinceDecide = HEARTBEAT;       // force a decide on first tick
    this.eventCursor = { lastEventIndex: 0 };
    this._inFlight = false;
    this._lastVisibleSig = '';
    // Random per-agent meeting-cadence offset so 10 agents don't all
    // speak at the same instant when a meeting opens.
    this._meetingJitter = Math.random() * 4;
  }

  update(dt) {
    if (this.game.phase === 'meeting') {
      this._updateInMeeting(dt);
      return;
    }
    this.timeSinceDecide += dt;

    // Always tick the current executor — it's the agent's commitment between
    // brain calls. The brain might still be thinking; the body keeps moving.
    if (this.exec) {
      const status = this.exec.step(dt);
      if (status.done) {
        this.action = null;
        this.exec = null;
      }
    }

    if (!this._inFlight && this._shouldDecide()) {
      this._fireDecide();
    }
  }

  _shouldDecide() {
    if (!this.action) return true;                          // nothing in progress
    if (this.timeSinceDecide >= MAX_IDLE_BEFORE_DECIDE) return true; // safety
    if (this.timeSinceDecide < HEARTBEAT) return false;     // throttle

    // Sleep heuristic: skip the LLM call if the world looks unchanged.
    // We re-decide if there are new visible events, the visible player set
    // changed, or we can see a body (always worth thinking about).
    const newEvents = this.game.events.length > this.eventCursor.lastEventIndex;
    if (newEvents) return true;

    const sig = this._visibilitySignature();
    if (sig !== this._lastVisibleSig) return true;

    return false;
  }

  _visibilitySignature() {
    // Cheap proxy: room + sorted ids of nearby players + body count.
    const room = this.player.getCurrentRoom() ?? '-';
    const nearby = this.game.players
      .filter(p => p.alive && p.id !== this.player.id)
      .filter(p => (p.x - this.player.x) ** 2 + (p.y - this.player.y) ** 2 < 300 * 300)
      .map(p => p.id).sort().join(',');
    const bodies = this.game.bodies.filter(b => !b.reported).length;
    return `${room}|${nearby}|${bodies}`;
  }

  async _fireDecide() {
    this._inFlight = true;
    this.timeSinceDecide = 0;
    try {
      const { observation, cursor } = buildObservation(this.game, this.player, this.eventCursor);
      this.eventCursor = cursor;
      this._lastVisibleSig = this._visibilitySignature();

      const ctxAction = this.action;
      const result = await this.brain.decide(
        observation,
        { ...this.scratchpad, currentAction: ctxAction },
      );
      const { action, scratchpad } = result || {};
      if (scratchpad !== undefined) this.scratchpad = scratchpad;

      // Phase might have flipped to meeting / ended while we awaited.
      if (this.game.phase !== 'playing') return;

      this.action = action || wait(0.5);
      this.exec = makeExecutor(this.action, this.player, this.game);
    } finally {
      this._inFlight = false;
    }
  }

  _updateInMeeting(dt) {
    this.player.setIntent(0, 0);
    this.action = null;
    this.exec = null;

    // Fresh jitter on each new meeting (detected by reporter/start-time change).
    const meetingId = this.game.meeting?.startedAt;
    if (meetingId !== this._lastMeetingId) {
      this._lastMeetingId = meetingId;
      this._meetingJitter = Math.random() * 4;
      this.timeSinceDecide = 0;
    }

    this.timeSinceDecide += dt;
    if (this._inFlight || !this.player.alive) return;
    if (this.timeSinceDecide < MEETING_HEARTBEAT + this._meetingJitter) return;
    this._meetingJitter = 0; // stagger only applies to the first decide of this meeting
    this._fireMeetingDecide();
  }

  async _fireMeetingDecide() {
    this._inFlight = true;
    this.timeSinceDecide = 0;
    try {
      const { observation, cursor } = buildObservation(this.game, this.player, this.eventCursor);
      this.eventCursor = cursor;
      const { action, scratchpad } = (await this.brain.decide(observation, this.scratchpad)) || {};
      if (scratchpad !== undefined) this.scratchpad = scratchpad;
      if (!action || this.game.phase !== 'meeting') return;
      if (action.type === 'speak') this.game.speak(this.player.id, action.text);
      else if (action.type === 'vote') this.game.castVote(this.player.id, action.targetId);
    } finally {
      this._inFlight = false;
    }
  }
}

// Slower meeting cadence so the chat doesn't spam — with 10 agents at 7s
// you get ~1.4 decisions/sec total, and most return wait. Feels conversational.
const MEETING_HEARTBEAT = 7;

// ========================
// EXECUTORS
// ========================

function makeExecutor(action, player, game) {
  switch (action.type) {
    case 'move-to-room': {
      const c = getSpawnPoint(action.room);
      return new MoveToPointExec(player, c.x, c.y, { arriveRoom: action.room, game });
    }
    case 'do-task':       return new DoTaskExec(player, game, action.taskId);
    case 'wait':          return new WaitExec(player, action.seconds ?? 1);
    case 'kill-nearest':  return new KillNearestExec(player, game);
    case 'report-body':   return new ReportBodyExec(player, game);
    case 'sabotage':      return new SabotageExec(player, game, action.sabotage);
    case 'fix-sabotage':  return new FixSabotageExec(player, game);
    case 'close-door':    return new CloseDoorExec(player, game, action.doorId);
    case 'vent-to':       return new VentToExec(player, game, action.ventId);
    // Schema-documented but not yet implemented:
    case 'call-meeting': case 'speak': case 'vote':
      return new WaitExec(player, 0.1);
    default:
      return new WaitExec(player, 0.5);
  }
}

// ------------------------
// Move-to-point (grid A*)
// ------------------------

class MoveToPointExec {
  /**
   * @param {object} player
   * @param {number} gx
   * @param {number} gy
   * @param {{ arriveRoom?: string, game?: object }} opts
   *   arriveRoom: if set, we consider arrival successful as soon as the player
   *   enters this room — avoids overshooting into the centroid through a crowd.
   */
  constructor(player, gx, gy, opts = {}) {
    this.player = player;
    this.goal = { x: gx, y: gy };
    this.arriveRoom = opts.arriveRoom ?? null;
    this.path = findPath(player.x, player.y, gx, gy);
    this.idx = 0;
    this.stuckTimer = 0;
    this.bestWpDist = Infinity;     // best distance reached toward current waypoint
    this.skipsThisLeg = 0;          // consecutive waypoint skips without progress
  }

  step(dt) {
    const p = this.player;
    if (this.arriveRoom && p.getCurrentRoom() === this.arriveRoom &&
        Math.hypot(p.x - this.goal.x, p.y - this.goal.y) < 50) {
      p.setIntent(0, 0);
      return { done: true };
    }
    if (this.path.length === 0 || this.idx >= this.path.length) {
      p.setIntent(0, 0);
      return { done: true };
    }

    const wp = this.path[this.idx];
    const dx = wp.x - p.x, dy = wp.y - p.y;
    const dist = Math.hypot(dx, dy);
    const arriveAt = this.idx === this.path.length - 1 ? ARRIVE_RADIUS : ARRIVE_RADIUS + 4;
    if (dist < arriveAt) {
      this.idx++;
      this.bestWpDist = Infinity;
      this.skipsThisLeg = 0;
      if (this.idx >= this.path.length) {
        p.setIntent(0, 0);
        return { done: true };
      }
    }
    p.setIntent(dx / (dist || 1), dy / (dist || 1));

    // Track progress toward the *current waypoint*, not raw motion. Sliding
    // along a wall counts as motion but isn't progress; without this check an
    // agent will orbit a corner forever.
    if (dist < this.bestWpDist - 1) {
      this.bestWpDist = dist;
      this.stuckTimer = 0;
    } else {
      this.stuckTimer += dt;
    }
    if (this.stuckTimer >= STUCK_WINDOW) {
      this.stuckTimer = 0;
      this.skipsThisLeg++;
      if (this.skipsThisLeg === 1 && this.idx < this.path.length - 1) {
        // First try: assume this single waypoint is wedged; skip past it.
        this.idx++;
        this.bestWpDist = Infinity;
      } else {
        // Still stuck — full replan from current position.
        this.path = findPath(p.x, p.y, this.goal.x, this.goal.y);
        this.idx = 0;
        this.bestWpDist = Infinity;
        this.skipsThisLeg = 0;
      }
    }
    return { done: false };
  }
}

// ------------------------
// Do-task
// ------------------------

class DoTaskExec {
  constructor(player, game, taskId) {
    this.player = player;
    this.game = game;
    this.taskId = taskId;
    this.mover = null;
  }
  _task() { return this.game.tasks.find(t => t.id === this.taskId); }

  step(dt) {
    const p = this.player;
    const task = this._task();
    if (!task || task.completed || task.playerId !== p.id) {
      p.setIntent(0, 0);
      return { done: true };
    }

    const dx = task.def.x - p.x;
    const dy = task.def.y - p.y;
    const distSq = dx * dx + dy * dy;
    const r2 = TASK_INTERACT_RADIUS * TASK_INTERACT_RADIUS;

    if (distSq > r2) {
      if (!this.mover) this.mover = new MoveToPointExec(p, task.def.x, task.def.y);
      return this.mover.step(dt);
    }

    p.setIntent(0, 0);
    this.game.advanceTask(p, task, dt);
    return { done: task.completed };
  }
}

// ------------------------
// Wait / tap-fire
// ------------------------

class WaitExec {
  constructor(player, seconds) { this.player = player; this.left = seconds; }
  step(dt) { this.player.setIntent(0, 0); this.left -= dt; return { done: this.left <= 0 }; }
}

class KillNearestExec {
  constructor(player, game) { this.player = player; this.game = game; this.done = false; }
  step() {
    if (!this.done) { this.game.tryKill(this.player); this.done = true; }
    this.player.setIntent(0, 0);
    return { done: true };
  }
}

class ReportBodyExec {
  constructor(player, game) { this.player = player; this.game = game; this.done = false; }
  step() {
    if (!this.done) { this.game.tryReportBody(this.player); this.done = true; }
    this.player.setIntent(0, 0);
    return { done: true };
  }
}

// ------------------------
// Vent-to: composite multi-stage executor.
//   1. Walk to the nearest vent in the SAME network as the target vent.
//   2. Enter that source vent (becomes invisible).
//   3. "Travel" for VENT_TRAVEL_DURATION seconds (stays invisible).
//   4. Exit at the target vent.
// ------------------------
class VentToExec {
  constructor(player, game, targetVentId) {
    this.player = player;
    this.game = game;
    this.targetVentId = Number(targetVentId);
    this.phase = 'route';    // route → entering → travel → exit
    this.travelLeft = 0;
    this.mover = null;
    this.sourceVent = this._chooseSourceVent();
  }

  /** Pick the vent in the target's network that's closest to the player NOW. */
  _chooseSourceVent() {
    const network = this.game.ventNetworkFor(this.targetVentId);
    if (network.length === 0) return null;
    const p = this.player;
    let best = null, bestD2 = Infinity;
    for (const v of network) {
      const d2 = (v.x - p.x) ** 2 + (v.y - p.y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = v; }
    }
    return best;
  }

  step(dt) {
    const p = this.player;
    if (!this.sourceVent) { p.setIntent(0, 0); return { done: true }; }

    if (this.phase === 'route') {
      if (!this.mover) this.mover = new MoveToPointExec(p, this.sourceVent.x, this.sourceVent.y);
      const r = this.mover.step(dt);
      // Close enough to enter? (mover's ARRIVE_RADIUS already snaps near it)
      const d2 = (this.sourceVent.x - p.x) ** 2 + (this.sourceVent.y - p.y) ** 2;
      if (d2 < 25 * 25 || r.done) {
        if (this.game.enterVent(p, this.sourceVent.id)) {
          this.phase = 'travel';
          this.travelLeft = 1.2; // matches VENT_TRAVEL_DURATION
        } else {
          // Couldn't enter (maybe phase changed, or we're not actually in range).
          return { done: true };
        }
      }
      return { done: false };
    }

    if (this.phase === 'travel') {
      p.setIntent(0, 0);
      this.travelLeft -= dt;
      if (this.travelLeft <= 0) this.phase = 'exit';
      return { done: false };
    }

    if (this.phase === 'exit') {
      this.game.exitVent(p, this.targetVentId);
      return { done: true };
    }
    return { done: true };
  }
}

// ------------------------
// Close-door: impostor slams a door from anywhere by id.
// ------------------------
class CloseDoorExec {
  constructor(player, game, doorId) {
    this.player = player; this.game = game; this.doorId = doorId; this.done = false;
  }
  step() {
    if (!this.done) {
      this.game.tryCloseDoor(this.player, this.doorId);
      this.done = true;
    }
    this.player.setIntent(0, 0);
    return { done: true };
  }
}

// ------------------------
// Sabotage: impostor triggers a sabotage from anywhere.
// ------------------------
class SabotageExec {
  constructor(player, game, kind) {
    this.player = player; this.game = game; this.kind = kind; this.done = false;
  }
  step() {
    if (!this.done) {
      this.game.tryStartSabotage(this.player, this.kind);
      this.done = true;
    }
    this.player.setIntent(0, 0);
    return { done: true };
  }
}

// ------------------------
// Fix-sabotage: route to the nearest fix spot, then drive the fix bar.
// ------------------------
class FixSabotageExec {
  constructor(player, game) {
    this.player = player;
    this.game = game;
    this.mover = null;
  }
  step(dt) {
    const p = this.player;
    const s = this.game.activeSabotage;
    if (!s) { p.setIntent(0, 0); return { done: true }; }

    // Pick a fix spot we're nearest to.
    let target = s.fixSpots[0];
    let bestD2 = (target.x - p.x) ** 2 + (target.y - p.y) ** 2;
    for (let i = 1; i < s.fixSpots.length; i++) {
      const sp = s.fixSpots[i];
      const d2 = (sp.x - p.x) ** 2 + (sp.y - p.y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; target = sp; }
    }

    if (this.game.nearestSabotageFix(p)) {
      p.setIntent(0, 0);
      this.game.advanceFixSabotage(p, dt);
      // When sabotage clears, activeSabotage becomes null → done next tick.
      return { done: !this.game.activeSabotage };
    }

    if (!this.mover || this.mover.goal?.x !== target.x || this.mover.goal?.y !== target.y) {
      this.mover = new MoveToPointExec(p, target.x, target.y);
    }
    return this.mover.step(dt);
  }
}
