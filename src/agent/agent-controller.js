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

import { getSpawnPoint, getRoomAt } from '../collision.js';
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
    // Rolling sightings log — per-agent timeline of "I saw X in room Y at t=Z".
    // Drives evidence-based voting and lets old sightings fade ("stale") in the
    // meeting prompt rather than being claimed as fresh.
    this.sightings = []; // [{ t, playerId, name, room }]
    this._lastSightingSampleAt = -Infinity;
    // Permanent log of game-defining things the agent personally witnessed
    // (kills, vent enters/exits). Surfaced at the top of every meeting prompt
    // to harden agents against gaslighting (Hoodwinked finding).
    this.iSawDirectly = [];
    this._witnessEventCursor = 0;
    // Meeting-chat scheduler state. We don't poll on a fixed heartbeat any
    // more — instead we pick `_nextMeetingDecideAt` reactively based on
    // sub-phase changes, new transcript messages, and whether we were
    // addressed by name. See `_updateInMeeting` for the rules.
    this._lastMeetingId = null;
    this._meetingTranscriptCursor = 0;
    this._meetingLastSubPhase = null;
    this._meetingLastSpokeAt = -Infinity;
    this._meetingLastDecideAt = -Infinity;
    this._nextMeetingDecideAt = Infinity;
    // Controller-level stuck detection. Lives outside the executor so it
    // survives action changes (the brain re-issuing a different action mid-move
    // would otherwise reset the executor's internal stuck timer and the agent
    // could oscillate in a corner forever).
    // Window of recent positions (timestamps + xy) for stuck detection. We use
    // the BOUNDING BOX of the last STUCK_WINDOW seconds — that way an agent
    // oscillating back-and-forth across a wall corner (which would defeat a
    // "displacement from anchor" check by repeatedly crossing the threshold)
    // still reads as stuck because the bbox stays small.
    this._posTrail = []; // [{t, x, y}]
    this._stuckReplans = 0;
  }

  update(dt) {
    this._harvestWitnessEvents();
    if (this.game.phase === 'meeting') {
      this._updateInMeeting(dt);
      return;
    }
    this._sampleSightings();
    this.timeSinceDecide += dt;

    // Always tick the current executor — it's the agent's commitment between
    // brain calls. The brain might still be thinking; the body keeps moving.
    if (this.exec) {
      const status = this.exec.step(dt);
      if (status.done) {
        this.action = null;
        this.exec = null;
        this._resetStuck();
      }
    }

    this._checkStuck(dt);

    if (!this._inFlight && this._shouldDecide()) {
      this._fireDecide();
    }
  }

  _resetStuck() {
    this._posTrail = [];
    this._stuckReplans = 0;
  }

  /**
   * If the player's recent positions all fit in a small bounding box while a
   * movement executor is active, treat the agent as stuck: first force the
   * underlying mover to replan, and after repeated failures abandon the action
   * so the brain picks something new.
   */
  _checkStuck(dt) {
    if (!this.exec || !this.action) { this._posTrail.length = 0; return; }
    const moves = ['move-to-room', 'do-task', 'vent-to', 'fix-sabotage', 'call-meeting', 'report-body'];
    if (!moves.includes(this.action.type)) { this._posTrail.length = 0; return; }

    const t = this.game.time;
    const WINDOW = 2.0;
    const BBOX_THRESH = 30; // px: smaller bbox over WINDOW seconds = stuck

    this._posTrail.push({ t, x: this.player.x, y: this.player.y });
    while (this._posTrail.length && t - this._posTrail[0].t > WINDOW) this._posTrail.shift();
    if (t - this._posTrail[0].t < WINDOW) return; // not enough history yet

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of this._posTrail) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    if (Math.max(maxX - minX, maxY - minY) > BBOX_THRESH) return; // moving freely

    // Stuck. Wipe trail so we don't re-fire every frame.
    this._posTrail.length = 0;
    this._stuckReplans++;
    const mover = this._activeMover();
    if (this._stuckReplans <= 2 && mover) {
      mover.path = findPath(this.player.x, this.player.y, mover.goal.x, mover.goal.y);
      mover.idx = 0;
      mover.bestWpDist = Infinity;
      mover.skipsThisLeg = 0;
    } else {
      this.action = null;
      this.exec = null;
      this._stuckReplans = 0;
      this.timeSinceDecide = HEARTBEAT;
    }
  }

  /** Reach into composite executors to find the MoveToPointExec actually driving motion. */
  _activeMover() {
    const e = this.exec;
    if (!e) return null;
    if (e instanceof MoveToPointExec) return e;
    if (e.mover instanceof MoveToPointExec) return e.mover;
    return null;
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

  _harvestWitnessEvents() {
    // Scan new game events for ones THIS agent personally witnessed and
    // accumulate human-readable lines. Permanent log; never decays.
    const me = this.player;
    const evs = this.game.events;
    for (let i = this._witnessEventCursor; i < evs.length; i++) {
      const ev = evs[i];
      const sawIt = ev.witnessIds && ev.witnessIds.includes(me.id);
      if (!sawIt) continue;
      const t = ev.t?.toFixed?.(1) ?? '?';
      const nameOf = (id) => {
        const p = this.game.players.find(pp => pp.id === id);
        return p ? p.name : `player#${id}`;
      };
      if (ev.type === 'kill') {
        const room = this._roomAtPoint(ev.at?.x, ev.at?.y);
        this.iSawDirectly.push(`t=${t}: saw ${nameOf(ev.killerId)} kill ${nameOf(ev.victimId)} in ${room}`);
      } else if (ev.type === 'vent-enter') {
        const room = this._roomAtPoint(ev.at?.x, ev.at?.y);
        this.iSawDirectly.push(`t=${t}: saw ${nameOf(ev.playerId)} enter a vent in ${room}`);
      } else if (ev.type === 'vent-exit') {
        const room = this._roomAtPoint(ev.at?.x, ev.at?.y);
        this.iSawDirectly.push(`t=${t}: saw ${nameOf(ev.playerId)} emerge from a vent in ${room}`);
      }
    }
    this._witnessEventCursor = evs.length;
  }

  _roomAtPoint(x, y) {
    if (x == null || y == null) return 'a hallway';
    return getRoomAt(x, y) ?? 'a hallway';
  }

  _sampleSightings() {
    // Sample at most once per second; dedupe consecutive same-room sightings of
    // the same player. Capped at 60 entries (~oldest dropped) so the prompt
    // stays bounded over a long round.
    const t = this.game.time;
    if (t - this._lastSightingSampleAt < 1.0) return;
    this._lastSightingSampleAt = t;
    const me = this.player;
    if (!me.alive) return;
    const VISION_R2 = this.game.getVisionRadius(me) ** 2;
    for (const p of this.game.players) {
      if (p.id === me.id || !p.alive || p.inVent) continue;
      const dx = p.x - me.x, dy = p.y - me.y;
      if (dx * dx + dy * dy > VISION_R2) continue;
      // Approx LoS gate: skip the polygon test here (sampler runs hot). The
      // observation builder still uses the strict visibility polygon for the
      // current-frame visiblePlayers list. Sightings are advisory memory.
      const room = p.getCurrentRoom();
      const last = this.sightings[this.sightings.length - 1];
      if (last && last.playerId === p.id && last.room === room && t - last.t < 4) {
        last.t = t; // refresh timestamp instead of duplicating
        continue;
      }
      this.sightings.push({ t, playerId: p.id, name: p.name, room });
      if (this.sightings.length > 60) this.sightings.shift();
    }
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
      observation.mySightings = this.sightings;
      observation.iSawDirectly = this.iSawDirectly;

      const ctxAction = this.action;
      const result = await this.brain.decide(
        observation,
        { ...this.scratchpad, currentAction: ctxAction },
      );
      const { action, scratchpad } = result || {};
      if (scratchpad !== undefined) this.scratchpad = scratchpad;

      // Phase might have flipped to meeting / ended while we awaited.
      if (this.game.phase !== 'playing') return;

      const nextAction = action || wait(0.5);
      // Preserve the executor (and its stuck-detection state) when the brain
      // re-issues the same action. Otherwise frequent re-decides at game start
      // — when many players are bunched in the cafeteria and the visibility
      // signature changes every tick — keep resetting stuckTimer, so the
      // mover's skip/replan logic never trips and the agent wedges in a corner.
      if (this.exec && actionsEquivalent(this.action, nextAction)) {
        this.action = nextAction;
      } else {
        this.action = nextAction;
        this.exec = makeExecutor(this.action, this.player, this.game);
        this._resetStuck();
      }
    } finally {
      this._inFlight = false;
    }
  }

  _updateInMeeting(dt) {
    this.player.setIntent(0, 0);
    this.action = null;
    this.exec = null;

    const m = this.game.meeting;
    if (!m) return;
    const now = this.game.time;

    // New meeting → reset chat scheduler state.
    if (m.startedAt !== this._lastMeetingId) {
      this._lastMeetingId = m.startedAt;
      this._meetingTranscriptCursor = 0;
      this._meetingLastSubPhase = null;
      this._meetingLastSpokeAt = -Infinity;
      this._meetingLastDecideAt = -Infinity;
      // Initial per-agent stagger so 10 agents don't pile in at t=0.
      this._nextMeetingDecideAt = now + 0.8 + Math.random() * 2.4;
    }

    if (!this.player.alive) return;

    // Sub-phase changed (discussion → voting → results): always re-decide soon.
    // Critical for voting — without this, an agent who just spoke could sit at
    // its post-speak cooldown and miss the entire voting window.
    if (m.subPhase !== this._meetingLastSubPhase) {
      this._meetingLastSubPhase = m.subPhase;
      this._nextMeetingDecideAt = Math.min(this._nextMeetingDecideAt, now + 0.2);
    }

    // Consume any new transcript lines since we last looked. New chatter is the
    // primary signal to re-decide — agents react to what others said, not the clock.
    if (m.subPhase === 'discussion' && m.transcript.length > this._meetingTranscriptCursor) {
      const newMsgs = m.transcript.slice(this._meetingTranscriptCursor);
      this._meetingTranscriptCursor = m.transcript.length;
      const addressed = newMsgs.some(msg =>
        msg.playerId !== this.player.id && this._mentionsMe(msg.text)
      );
      const fromMe = newMsgs.every(msg => msg.playerId === this.player.id);
      if (!fromMe) {
        // Addressed → snap reply (0.4–1.0s). Otherwise pause to "think" (1.2–2.6s)
        // so the chat doesn't read like a simultaneous keysmash.
        const delay = addressed ? 0.4 + Math.random() * 0.6
                                : 1.2 + Math.random() * 1.4;
        this._nextMeetingDecideAt = Math.min(this._nextMeetingDecideAt, now + delay);
      }
    }

    // Backstop: even with zero new messages, decide at least every MEETING_BACKSTOP
    // seconds so a quiet agent still gets a chance to speak / will be ready to vote.
    const backstop = this._meetingLastDecideAt + MEETING_BACKSTOP;
    if (backstop < this._nextMeetingDecideAt) this._nextMeetingDecideAt = backstop;

    if (this._inFlight) return;
    if (now < this._nextMeetingDecideAt) return;

    // If I just spoke and nobody addressed me, defer — let others respond.
    if (m.subPhase === 'discussion'
        && now - this._meetingLastSpokeAt < POST_SPEAK_COOLDOWN
        && !this._addressedInRecentTail(m)) {
      this._nextMeetingDecideAt = now + 3;
      return;
    }

    this._fireMeetingDecide();
  }

  _mentionsMe(text) {
    if (!text || !this.player.name) return false;
    return new RegExp(`\\b${this.player.name}\\b`, 'i').test(text);
  }

  _addressedInRecentTail(m) {
    const tail = m.transcript.slice(-4);
    return tail.some(msg => msg.playerId !== this.player.id && this._mentionsMe(msg.text));
  }

  async _fireMeetingDecide() {
    this._inFlight = true;
    this._meetingLastDecideAt = this.game.time;
    this._nextMeetingDecideAt = Infinity; // scheduler will repopulate from triggers
    try {
      const { observation, cursor } = buildObservation(this.game, this.player, this.eventCursor);
      this.eventCursor = cursor;
      observation.mySightings = this.sightings;
      observation.iSawDirectly = this.iSawDirectly;
      const { action, scratchpad } = (await this.brain.decide(observation, this.scratchpad)) || {};
      if (scratchpad !== undefined) this.scratchpad = scratchpad;
      if (!action || this.game.phase !== 'meeting') return;
      if (action.type === 'speak') {
        if (this.game.speak(this.player.id, action.text)) {
          this._meetingLastSpokeAt = this.game.time;
        }
      } else if (action.type === 'vote') {
        this.game.castVote(this.player.id, action.targetId);
      }
    } finally {
      this._inFlight = false;
    }
  }
}

// Backstop heartbeat — never go longer than this between decides, even if the
// chat is dead silent. Cheap insurance against missing the voting window.
const MEETING_BACKSTOP = 12;
// After speaking, hold off on more chatter unless addressed by name.
const POST_SPEAK_COOLDOWN = 4;

function actionsEquivalent(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  switch (a.type) {
    case 'move-to-room': return a.room === b.room;
    case 'do-task':      return a.taskId === b.taskId;
    case 'sabotage':     return a.sabotage === b.sabotage;
    case 'close-door':   return a.doorId === b.doorId;
    case 'vent-to':      return Number(a.ventId) === Number(b.ventId);
    case 'kill-nearest':
    case 'report-body':
    case 'fix-sabotage':
    case 'call-meeting': return true;
    default: return false; // wait/speak/vote — always rebuild
  }
}

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
    case 'call-meeting':  return new CallMeetingExec(player, game);
    // Speak/vote are handled directly in _fireMeetingDecide, not via executor.
    case 'speak': case 'vote':
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
// Call-meeting: agent walks to the Cafeteria emergency button, then presses it.
// One-shot per agent per game; tryCallMeeting enforces eligibility.
// ------------------------
class CallMeetingExec {
  constructor(player, game) {
    this.player = player; this.game = game;
    this.mover = new MoveToPointExec(player, 955, 240, { arriveRoom: 'Cafeteria', game });
    this.pressed = false;
  }
  step(dt) {
    const p = this.player;
    const dx = p.x - 955, dy = p.y - 240;
    if (!this.pressed && p.getCurrentRoom() === 'Cafeteria' && dx * dx + dy * dy < 130 * 130) {
      this.game.tryCallMeeting(p);
      this.pressed = true;
      p.setIntent(0, 0);
      return { done: true };
    }
    return this.mover.step(dt);
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
