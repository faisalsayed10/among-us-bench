// ========================
// OBSERVATION BUILDER
// ========================
// Constructs an Observation snapshot for one agent — what THAT player would
// reasonably perceive right now. Visibility is gated by line-of-sight; recent
// events are filtered to those the agent could have witnessed.
//
// Each agent tracks how many events they've already consumed via
// `lastEventIndex`, so two calls in a row don't repeat history.

import { computeVisibilityPolygon } from '../visibility.js';
import { tasksForPlayer } from '../tasks.js';
import { getRoomAt } from '../collision.js';
import { SABOTAGE_DEFS } from '../game-state.js';
import { vents as VENT_DEFS, ventConnections as VENT_CONNECTIONS } from '../map-data.js';

/** Static catalog of vent networks for impostor prompts. */
function ventNetworksForObservation() {
  return VENT_CONNECTIONS.map(net =>
    net.map(id => {
      const v = VENT_DEFS.find(vv => vv.id === id);
      return { id, room: v?.room };
    })
  );
}

// Use the game-state's per-player vision radius so lights-out actually
// reduces what crewmate agents perceive.

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

/**
 * Build the observation for `self`. `cursor` is the agent's running event
 * cursor; this function returns the updated cursor too so the caller can
 * persist it on the agent.
 *
 * @param {import('../game-state.js').GameState} game
 * @param {import('../player.js').Player} self
 * @param {{ lastEventIndex: number }} cursor
 * @returns {{ observation: import('./schema.js').Observation, cursor: { lastEventIndex: number } }}
 */
export function buildObservation(game, self, cursor) {
  const VISION_RADIUS = game.getVisionRadius(self);
  const visPoly = computeVisibilityPolygon(self.x, self.y, VISION_RADIUS);

  const isVisible = (x, y) => {
    const dx = x - self.x, dy = y - self.y;
    if (dx * dx + dy * dy > VISION_RADIUS * VISION_RADIUS) return false;
    return pointInPolygon(x, y, visPoly);
  };

  // Visible players (in-vent players are hidden from everyone — that's the point)
  const visiblePlayers = [];
  for (const p of game.players) {
    if (p.id === self.id || !p.alive || p.inVent) continue;
    if (!isVisible(p.x, p.y)) continue;
    visiblePlayers.push({
      id: p.id,
      name: p.name,
      color: p.color,
      room: p.getCurrentRoom(),
      x: p.x,
      y: p.y,
      alive: p.alive,
      activity: p.walking ? 'walking' : 'idle',
    });
  }

  // Visible bodies (unreported only — once reported the meeting starts and the body is moot)
  const visibleBodies = [];
  for (const b of game.bodies) {
    if (b.reported) continue;
    if (!isVisible(b.x, b.y)) continue;
    visibleBodies.push({
      bodyId: b.id,
      victimId: b.victimId,
      victimName: b.name,
      room: getRoomAt(b.x, b.y),
      x: b.x,
      y: b.y,
    });
  }

  // Self task views (includes fake tasks for impostors — they look identical so
  // the impostor can blend in by "doing" them).
  const tasks = tasksForPlayer(game.tasks, self.id).map(t => ({
    id: t.id,
    name: t.def.name,
    room: t.def.room,
    x: t.def.x,
    y: t.def.y,
    progress: t.progress,
    completed: t.completed,
    fake: !!t.fake,
  }));

  // Recent events since last call. We don't try to filter perfectly by
  // perception — meeting-wide events (meetings start/end, role assignment)
  // are always visible; spatial events (kill, task-complete) are visible
  // if the agent was within perception radius at emit time.
  const startIdx = cursor.lastEventIndex ?? 0;
  const recentEvents = [];
  for (let i = startIdx; i < game.events.length; i++) {
    const ev = game.events[i];
    if (isEventVisibleTo(ev, self)) recentEvents.push(stripEvent(ev));
  }

  // Meeting view (only when relevant). Agents see the running transcript and
  // know who has cast a vote — but NOT what those votes were until results.
  let meeting = null;
  if (game.phase === 'meeting' && game.meeting) {
    meeting = {
      subPhase: game.meeting.subPhase,
      timeLeft: Math.max(0, game.meeting.subPhaseEndsAt - game.time),
      reporterId: game.meeting.reporterId,
      // Everyone is gathered during a meeting — agents see the full roster
      // so they can vote on anyone alive.
      attendees: game.players.map(p => ({
        id: p.id, name: p.name, color: p.color, alive: p.alive,
      })),
      transcript: game.meeting.transcript.map(m => ({
        playerId: m.playerId, name: m.name, text: m.text, t: m.t,
      })),
      voterIds: [...game.meeting.votes.keys()],
      myVote: game.meeting.votes.get(self.id) ?? null,
      // At results, expose ejection so brains can react.
      ejection: game.meeting.subPhase === 'results' ? {
        ejectedId: game.meeting.ejectedId,
        wasImpostor: game.meeting.ejectedWasImpostor,
      } : null,
    };
  }

  // Impostors know who their fellow impostor(s) are — Among Us rule.
  // Augmented with current room + activity so they can coordinate (don't both
  // accuse the same crewmate, don't kill in a room your teammate is fake-tasking
  // in, etc.).
  const fellowImpostors = self.role === 'impostor'
    ? game.players
        .filter(p => p.role === 'impostor' && p.id !== self.id)
        .map(p => ({
          id: p.id, name: p.name, alive: p.alive,
          room: p.alive ? p.getCurrentRoom() : null,
          inVent: !!p.inVent,
          killCooldown: p.killCooldown,
        }))
    : [];

  // Kill strategy signal for impostors — who's nearby, who's isolated, which
  // vent exits look clear. Pure derived info; lets the brain decide WHEN to
  // strike instead of just calling kill-nearest the moment cooldown hits 0.
  let killSignal = null;
  if (self.role === 'impostor' && self.alive && !self.inVent) {
    const HUNT_RADIUS = 280;
    const ISOLATION_RADIUS = 220;
    const nearby = [];
    for (const p of game.players) {
      if (!p.alive || p.role === 'impostor' || p.inVent || p.id === self.id) continue;
      const d = Math.hypot(p.x - self.x, p.y - self.y);
      if (d > HUNT_RADIUS) continue;
      // Isolated = no OTHER living non-impostor (and no non-teammate witness) within radius of p.
      let alone = true;
      for (const q of game.players) {
        if (q.id === p.id || q.id === self.id || !q.alive || q.inVent) continue;
        if (q.role === 'impostor') continue; // teammates don't count as witnesses
        if (Math.hypot(q.x - p.x, q.y - p.y) < ISOLATION_RADIUS) { alone = false; break; }
      }
      nearby.push({
        id: p.id, name: p.name, room: p.getCurrentRoom(),
        distance: Math.round(d), isolated: alone,
      });
    }
    nearby.sort((a, b) => a.distance - b.distance);
    // Clear vent exits = vents in your reachable networks where no non-impostor
    // is currently visible at the exit point.
    const clearVentExits = [];
    for (const net of VENT_CONNECTIONS) {
      for (const id of net) {
        const v = VENT_DEFS.find(vv => vv.id === id);
        if (!v) continue;
        let clear = true;
        for (const q of game.players) {
          if (!q.alive || q.inVent || q.role === 'impostor') continue;
          if (Math.hypot(q.x - v.x, q.y - v.y) < 200) { clear = false; break; }
        }
        if (clear) clearVentExits.push({ id, room: v.room });
      }
    }
    killSignal = { nearby, clearVentExits };
  }

  // Past meeting outcomes (cross-round learning). Strips voter→target into
  // a compact form the brain can use to update beliefs.
  const nameOf = (id) => {
    if (id == null || id === 'skip') return id === 'skip' ? 'skip' : null;
    const p = game.players.find(pp => pp.id === id);
    return p ? p.name : `player#${id}`;
  };
  const pastMeetings = game.pastMeetings.map(pm => ({
    t: pm.t,
    reporterId: pm.reporterId,
    reporterName: nameOf(pm.reporterId),
    ejectedId: pm.ejectedId,
    ejectedName: nameOf(pm.ejectedId),
    wasImpostor: pm.wasImpostor,
    votes: pm.votes.map(v => ({
      voterId: v.voterId, voterName: nameOf(v.voterId),
      targetId: v.targetId, targetName: nameOf(v.targetId),
    })),
  }));

  const observation = {
    self: {
      id: self.id,
      name: self.name,
      role: self.role,
      alive: self.alive,
      position: { x: self.x, y: self.y, room: self.getCurrentRoom() },
      killCooldown: self.role === 'impostor' ? self.killCooldown : 0,
      tasks,
      fellowImpostors,
    },
    worldTime: game.time,
    phase: game.phase,
    visiblePlayers,
    visibleBodies,
    recentEvents,
    globalTaskProgress: game.globalTaskProgress(),
    meeting,
    sabotage: game.activeSabotage ? {
      type: game.activeSabotage.type,
      label: SABOTAGE_DEFS[game.activeSabotage.type]?.label || game.activeSabotage.type,
      timeLeft: game.activeSabotage.deadline != null
        ? Math.max(0, game.activeSabotage.deadline - game.time) : null,
      // Per-spot status — agents can see which rooms still need fixing.
      fixSpots: game.activeSabotage.fixSpots.map(s => ({
        room: s.room, progress: s.progress, completed: s.completed,
      })),
    } : null,
    // Only impostors need to know their sabotage cooldown.
    sabotageCooldown: self.role === 'impostor' ? game.sabotageCooldownRemaining() : 0,
    // Doors: everyone sees which are currently closed (vision/pathing affordance).
    // Impostors additionally see the full catalog with semantic labels so they
    // can target a door by id.
    closedDoors: game.closedDoorIds(),
    doorCatalog: self.role === 'impostor' ? game.getDoorDefs() : null,
    // Vent catalog: only impostors get the full network map (and only they can use vents).
    ventNetworks: self.role === 'impostor' ? ventNetworksForObservation() : null,
    killSignal,
    pastMeetings,
  };

  return {
    observation,
    cursor: { lastEventIndex: game.events.length },
  };
}

// ------------------------
// Event visibility
// ------------------------

const GLOBAL_EVENT_TYPES = new Set([
  'roles-assigned', 'tasks-assigned',
  'meeting-start', 'meeting-end',
  'voting-start', 'voting-end',
  'body-reported',          // everyone is told a meeting was called
  'emergency-meeting',      // emergency button presses are public
  'sabotage-start',         // the entire ship sees the alert
  'sabotage-end',
  'door-closed',            // door slam is audible across the ship
  'door-opened',
  'game-end',
]);

function isEventVisibleTo(ev, self) {
  if (GLOBAL_EVENT_TYPES.has(ev.type)) return true;
  // Self-authored events are always visible (you know what you did)
  if (ev.playerId === self.id || ev.killerId === self.id || ev.reporterId === self.id) return true;
  // Spatial events: stamped with the witness list at emit time (correct under
  // movement after the fact, unlike a proximity-now check).
  if (ev.witnessIds && ev.witnessIds.includes(self.id)) return true;
  return false;
}

function stripEvent(ev) {
  // Pass through with the keys an agent should see. We expose all fields for
  // now — when adding adversarial integrity, we'd redact e.g. killerId from
  // a kill the agent didn't actually witness.
  return { ...ev };
}
