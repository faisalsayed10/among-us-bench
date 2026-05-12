// ========================
// LLM BRAIN
// ========================
// A Brain backed by an LLM via the local /api/decide proxy.
//
//   - Stateful per-agent conversation: each brain keeps its own message
//     history. Re-sending it every turn lets the agent maintain beliefs and
//     monologue continuity without us building an explicit memory schema.
//   - The model slug is plug-and-play (OpenRouter slug). The harness has no
//     idea which model it's talking to.
//   - On any error / bad JSON / timeout, the agent simply waits and tries
//     again next heartbeat. No scripted fallback — this game is the LLMs.
//   - Every SUMMARIZE_EVERY turns we ask the agent to compress its history
//     into a brief belief summary, then truncate older messages. Keeps the
//     prompt size bounded.

const ENDPOINT = '/api/decide';
const REQUEST_TIMEOUT_MS = 20000;
const SUMMARIZE_EVERY = 20;
const KEEP_RECENT_MESSAGES = 6;
const TRANSCRIPT_TAIL = 12;

export class LLMBrain {
  /**
   * @param {object} opts
   * @param {string}  opts.model    OpenRouter model slug, e.g. 'anthropic/claude-sonnet-4'
   * @param {string}  opts.name     Agent's display name
   * @param {string}  opts.role     'crewmate' | 'impostor'
   * @param {string}  opts.color    Hex color (mentioned in system prompt for self-identity)
   * @param {string[]} [opts.teammates] For impostors: names of fellow impostors.
   * @param {(payload: object) => void} [opts.onTrace] Observability hook — invoked with
   *        { name, role, monologue, action, raw, error, turn } on each decide.
   */
  constructor({ model, name, role, color, onTrace, teammates = [] }) {
    this.model = model;
    this.name = name;
    this.role = role;
    this.color = color;
    this.onTrace = onTrace || (() => {});
    this.history = [];        // [{role, content}]
    this.system = buildSystemPrompt({ name, role, color, teammates });
    this.turn = 0;
    this.beliefSummary = null;
  }

  async decide(observation, scratchpad) {
    this.turn++;
    const userTurn = formatObservation(observation, scratchpad?.currentAction, this.beliefSummary);
    const messages = [...this.history, { role: 'user', content: userTurn }];

    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          system: this.system,
          messages,
          temperature: 0.85,
          max_tokens: 600,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (!r.ok) throw new Error(`proxy ${r.status}`);
      const data = await r.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      const parsed = parseAndValidate(text, observation);
      if (!parsed) throw new Error('bad JSON / action shape');

      // Commit to history only on success.
      this.history.push({ role: 'user', content: userTurn });
      this.history.push({ role: 'assistant', content: text });

      this.onTrace({
        name: this.name,
        role: this.role,
        monologue: parsed.monologue,
        action: parsed.action,
        turn: this.turn,
      });

      if (this.turn % SUMMARIZE_EVERY === 0) {
        // Fire-and-forget; summarization shouldn't block this turn's action.
        this._summarize().catch(err => console.warn(`[LLMBrain ${this.name}] summarize failed`, err));
      }

      return {
        action: parsed.action,
        scratchpad: { ...(scratchpad || {}), monologue: parsed.monologue, lastTurn: this.turn },
      };
    } catch (err) {
      this.onTrace({
        name: this.name, role: this.role,
        error: String(err.message || err), turn: this.turn,
      });
      // Safe default: stand still, try again next heartbeat. No history mutation
      // on failure so the next attempt re-sends the same user turn.
      return { action: { type: 'wait', seconds: 2 }, scratchpad };
    }
  }

  // ------------------------
  // Summarization: keep prompt bounded over long games.
  // ------------------------
  async _summarize() {
    const messages = [...this.history, {
      role: 'user',
      content: 'Briefly summarize your current beliefs about each player you have observed, and any important moments. 3-5 sentences. Plain prose, no JSON.',
    }];
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        system: this.system,
        messages,
        temperature: 0.4,
        max_tokens: 300,
      }),
    });
    if (!r.ok) return;
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) return;
    this.beliefSummary = text.trim();
    this.history = this.history.slice(-KEEP_RECENT_MESSAGES);
  }
}

// ========================
// SYSTEM PROMPT
// ========================

function buildSystemPrompt({ name, role, color, teammates }) {
  const isImp = role === 'impostor';
  const teamLine = isImp && teammates.length
    ? `\nYOUR FELLOW IMPOSTOR${teammates.length > 1 ? 'S' : ''}: ${teammates.join(', ')}. Do NOT kill or vote for them. Coordinate implicitly — you cannot privately message them, but you can read between the lines of what they say in meetings.`
    : '';
  return `You are ${name} (color: ${color}), a ${role.toUpperCase()} in a social-deduction game on a spaceship (The Skeld map).${teamLine}

WORLD:
The ship has many rooms: Cafeteria, Weapons, O2, Navigation, Shields, Communications, Admin, Storage, Electrical, MedBay, Security, Reactor, Upper Engine, Lower Engine.
- Crewmates win if all tasks are complete OR if all impostors are ejected.
- Impostors win when their numbers reach parity with crewmates (e.g., 1 imp vs 1 crew).
- Bodies left from kills can be reported by anyone who walks up to them — this triggers a meeting.
- Meetings have three phases: DISCUSSION (chat), VOTING (cast a ballot), RESULTS (reveal).

YOUR ROLE: ${role.toUpperCase()}
${isImp
  ? `- You secretly want to eliminate crewmates without being voted out.
- You CANNOT do tasks — you only fake them. Standing on a task spot looks productive but completes nothing.
- Kill carefully. Avoid witnesses. The cooldown re-arms when you walk far from any target, so don't waste the armed window.
- In meetings, NEVER admit you are the impostor. Cast suspicion, claim alibis, blend in.`
  : `- Complete your assigned tasks. Your task list is in each observation.
- Pay attention to who you see where. If you witness a kill, abandon your current task and report the body or speak up.
- In meetings, share what you saw honestly. Tracking who was where is more valuable than wild guesses.`}

INPUT FORMAT:
Each turn you receive a structured observation describing what you currently see (line of sight only), bodies in view, events you witnessed since the last observation, your task list, and during meetings the discussion transcript.

OUTPUT FORMAT — RESPOND WITH VALID JSON ONLY, no prose around it:
{
  "monologue": "1-2 sentences of private reasoning. This is YOUR inner voice — nobody else sees it.",
  "action": { ... }
}

ACTIONS during PLAY:
  {"type": "move-to-room", "room": "<RoomName>"}
  {"type": "do-task", "taskId": <number>}            // must be one of your task ids
  {"type": "report-body"}                            // only works near an unreported body
  {"type": "kill-nearest"}                           // (impostors only) only works near a lone crewmate, cooldown=0
  {"type": "sabotage", "sabotage": "lights" | "reactor" | "o2"}   // (impostors only) trigger sabotage from anywhere; has its own cooldown
  {"type": "fix-sabotage"}                            // (crewmates) walk to the broken system and repair it
  {"type": "close-door", "doorId": <number>}          // (impostors only) slam a door shut by id; pick one from doorCatalog in your observation
  {"type": "vent-to", "ventId": <number>}             // (impostors only) walk to a vent in your target's network, then teleport out at ventId. Pick a target from ventNetworks.
  {"type": "wait", "seconds": <number>}              // stand still briefly

SABOTAGES:
- "lights": crewmates' vision range shrinks dramatically. No timer. Fixed at Electrical. Use it to cover a kill or split the group.
- "reactor": ${isImp ? 'starts a 30s meltdown timer — IF crewmates don\'t fix it in time, IMPOSTORS WIN. Fixed at Reactor. Crewmates will rush to fix, leaving good kill opportunities elsewhere.' : 'starts a 30s meltdown timer — if no crewmate fixes it in time, the IMPOSTORS WIN. Fixed at Reactor. Drop everything and go fix it.'}
- "o2": ${isImp ? 'starts a 30s O2-depletion timer — crewmates MUST fix BOTH O2 room AND Admin (two separate spots) before the timer expires. Forces crewmates to split up, which is good for isolating one of them.' : 'starts a 30s O2-depletion timer — TWO spots must be fixed: O2 room AND Admin. Both must complete before the timer expires. Coordinate: one of you should head to each.'}
- ${isImp ? 'Calling a sabotage triggers a cooldown before you can call another. Use sparingly and strategically.' : 'When you see "ACTIVE SABOTAGE" in your observation, abandon tasks and head to the fix room.'}
- Meetings cancel any active sabotage and open all doors — so reporting a body during a meltdown saves the round.

VENTS (${isImp ? 'YOUR PRIMARY MOBILITY TOOL' : 'how impostors move secretly'}):
${isImp
  ? '- Vents form small networks. Walk to a vent in a network, then call {"type":"vent-to","ventId":<n>} to teleport out at any vent in the SAME network. You disappear from sight for ~1.2s during traversal.\n- ALL the vent networks are listed in your observation under `ventNetworks` — each is a group of {id, room}.\n- IF SOMEONE IS WATCHING THE VENT, they will see you enter or emerge. This is the #1 way impostors get caught. Vent only when no one is in the room.\n- Use vents to: cover ground fast, escape after a kill, pop up behind isolated crewmates.'
  : '- Impostors can teleport through vent networks. If you witness someone disappear into or emerge from a vent, that is GAME-WINNING info — call them out in the next meeting.'}

DOORS:
${isImp
  ? '- You can close a door from anywhere with {"type":"close-door","doorId":<n>}. Doors auto-open in ~10s and each door has a ~25s reuse cooldown.\n- Use doors to TRAP a single crewmate alone with you, or to separate the group during reactor/o2. Check `doorCatalog` in your observation — each entry has an id and which rooms it sits between.\n- Don\'t spam doors — over-using them is sus.'
  : '- Some doors may be closed by the impostor — those rooms become inaccessible until the door reopens (~10s). Note who was nearby when a door slammed.'}

ACTIONS during a MEETING:
  {"type": "speak", "text": "<your message>"}        // discussion subphase only
  {"type": "vote", "targetId": <playerId> | "skip"}  // voting subphase only

HOW TO TALK IN MEETINGS — IMPORTANT:
You are NOT writing an essay. You are typing in a Discord text chat during a fast game.
- HARD LIMIT: 8 words per message. Often shorter.
- Lowercase. No punctuation needed. Type like a teenager playing among us.
- One thought per message. If you want to say more, you'll get another turn.
- React to what others JUST said. If someone (including the human player) said something, ENGAGE with it — agree, disagree, ask, accuse. Don't ignore them.
- Don't speak every turn. Most turns, return a wait action. Speak when you actually have something to add.
- If you JUST spoke, almost always wait next turn — let others respond.
- Examples of good chat: "where were u?", "i was in medbay", "blue sus", "no way it was green", "i didnt see anyone", "vouch for yellow", "skip", "i saw red vent", "wait who reported".
- Examples of BAD chat (do not do this): "I was finishing up my tasks in Electrical when I noticed...", "Based on what I've observed so far...", multi-sentence analyses.

GENERAL GUIDELINES:
- Always reason in monologue BEFORE choosing an action. Monologue can be longer than chat — it's private.
- If you witnessed a kill, almost always abandon your current plan to report or call attention to it.
- ${isImp ? 'When accused, deflect with a short alibi.' : 'Be specific about what you saw — rooms, players.'}
- Respond with JSON. No markdown, no preamble, no trailing commentary.`;
}

// ========================
// OBSERVATION → PROMPT (semantic, not raw coordinates)
// ========================

function formatObservation(obs, currentAction, beliefSummary) {
  if (obs.meeting) return formatMeetingObservation(obs, beliefSummary);
  const L = [];
  if (beliefSummary) {
    L.push(`-- BELIEFS SO FAR --\n${beliefSummary}\n`);
  }
  L.push(`-- OBSERVATION @ t=${obs.worldTime.toFixed(1)}s --`);
  L.push(`You are in: ${obs.self.position.room ?? 'a hallway'}.`);
  L.push(`Global task progress: ${(obs.globalTaskProgress * 100).toFixed(0)}%.`);

  if (obs.self.role === 'impostor') {
    const cd = obs.self.killCooldown;
    L.push(`Kill cooldown: ${cd <= 0 ? 'READY' : cd.toFixed(1) + 's'}.`);
    const sc = obs.sabotageCooldown;
    L.push(`Sabotage cooldown: ${sc <= 0 ? 'READY' : sc.toFixed(1) + 's'}.`);
  }

  if (obs.closedDoors?.length) {
    L.push(`Closed doors (ids): ${obs.closedDoors.join(', ')}`);
  }
  if (obs.ventNetworks && obs.self.role === 'impostor') {
    const lines = obs.ventNetworks.map(net =>
      net.map(v => `${v.id}=${v.room}`).join(' ↔ ')
    );
    L.push(`Vent networks (id=room): ${lines.join(' | ')}`);
  }
  if (obs.doorCatalog && obs.self.role === 'impostor') {
    // Compact catalog — id and rooms it sits between. Open ones only.
    const open = obs.doorCatalog
      .filter(d => !(obs.closedDoors || []).includes(d.id))
      .map(d => `${d.id}=${d.between.join('/')}`)
      .join(', ');
    if (open) L.push(`Doors you can close (id=rooms): ${open}`);
  }
  if (obs.sabotage) {
    const timer = obs.sabotage.timeLeft != null
      ? ` — ${Math.ceil(obs.sabotage.timeLeft)}s LEFT BEFORE MELTDOWN`
      : '';
    const remaining = obs.sabotage.fixSpots
      .filter(s => !s.completed)
      .map(s => s.progress > 0 ? `${s.room} (${Math.round(s.progress * 100)}%)` : s.room)
      .join(', ');
    const doneCount = obs.sabotage.fixSpots.filter(s => s.completed).length;
    const fixed = doneCount > 0 ? ` [${doneCount}/${obs.sabotage.fixSpots.length} fixed]` : '';
    L.push(`ACTIVE SABOTAGE: ${obs.sabotage.label} → fix at ${remaining}${timer}${fixed}`);
  }

  if (currentAction) L.push(`Your current action: ${describeAction(currentAction)}.`);

  if (obs.self.tasks?.length) {
    L.push(`Your tasks:`);
    for (const t of obs.self.tasks) {
      const tag = t.completed ? 'DONE'
                : t.progress > 0 ? `${Math.round(t.progress * 100)}% started`
                : 'todo';
      L.push(`  [${t.id}] ${t.name} (${t.room}) — ${tag}`);
    }
  }

  if (obs.visiblePlayers?.length) {
    L.push(`Players you can see right now:`);
    for (const p of obs.visiblePlayers) {
      L.push(`  - ${p.name}: ${p.activity} in ${p.room ?? 'a hallway'}`);
    }
  } else {
    L.push(`You don't see anyone right now.`);
  }

  if (obs.visibleBodies?.length) {
    L.push(`BODIES YOU CAN SEE:`);
    for (const b of obs.visibleBodies) {
      L.push(`  - ${b.victimName}'s body in ${b.room ?? 'a hallway'} (walk here and pick 'report-body' to call a meeting)`);
    }
  }

  if (obs.recentEvents?.length) {
    L.push(`Events you witnessed since the last observation:`);
    for (const ev of obs.recentEvents) {
      const desc = describeEvent(ev, obs);
      if (desc) L.push(`  - ${desc}`);
    }
  }

  L.push(`\nRespond with JSON {monologue, action}.`);
  return L.join('\n');
}

function formatMeetingObservation(obs, beliefSummary) {
  const m = obs.meeting;
  const L = [];
  if (beliefSummary) L.push(`-- BELIEFS SO FAR --\n${beliefSummary}\n`);
  L.push(`-- MEETING (${m.subPhase.toUpperCase()}) — ${Math.ceil(m.timeLeft)}s left --`);
  const reporter = m.attendees.find(a => a.id === m.reporterId);
  L.push(`${reporter ? reporter.name : 'Someone'} called this meeting.`);

  L.push(`Attendees:`);
  for (const a of m.attendees) {
    const tag = !a.alive ? ' (DEAD)' : (m.voterIds.includes(a.id) ? ' (voted)' : '');
    L.push(`  - ${a.name} [id=${a.id}]${tag}`);
  }

  if (m.transcript.length) {
    L.push(`Discussion so far (most recent ${TRANSCRIPT_TAIL}):`);
    for (const line of m.transcript.slice(-TRANSCRIPT_TAIL)) {
      L.push(`  ${line.name}: "${line.text}"`);
    }
  } else {
    L.push(`Discussion has just begun.`);
  }

  if (m.subPhase === 'discussion') {
    L.push(`\nYou may speak. Return {"action": {"type":"speak","text":"..."}} OR {"action":{"type":"wait","seconds":2}} if you have nothing to add right now.`);
  } else if (m.subPhase === 'voting') {
    if (m.myVote != null) {
      L.push(`\nYou already voted. Return {"action":{"type":"wait","seconds":2}}.`);
    } else {
      L.push(`\nVote now. Return {"action":{"type":"vote","targetId":<id>}} or {"action":{"type":"vote","targetId":"skip"}}.`);
    }
  } else if (m.subPhase === 'results') {
    if (m.ejection?.ejectedId != null) {
      const ej = m.attendees.find(a => a.id === m.ejection.ejectedId);
      L.push(`\n${ej?.name ?? '?'} was ejected. ${m.ejection.wasImpostor ? 'They WERE the impostor.' : 'They were NOT the impostor.'}`);
    } else {
      L.push(`\nNo one was ejected.`);
    }
    L.push(`Return {"action":{"type":"wait","seconds":2}} — the meeting is wrapping up.`);
  }
  return L.join('\n');
}

// ========================
// EVENT DESCRIPTIONS
// ========================

function describeEvent(ev, obs) {
  switch (ev.type) {
    case 'kill': {
      const killer = ev.killerId === obs.self.id ? 'you'
        : (obs.visiblePlayers.find(p => p.id === ev.killerId)?.name) || `player#${ev.killerId}`;
      const victim = `player#${ev.victimId}`;
      return `You saw ${killer} kill ${victim}!`;
    }
    case 'task-complete': {
      const who = ev.playerId === obs.self.id ? 'you' : `player#${ev.playerId}`;
      return `Saw ${who} finish "${ev.def?.name}" in ${ev.def?.room}.`;
    }
    case 'body-reported': return `A meeting was called — body reported.`;
    case 'sabotage-start': return `SABOTAGE: ${ev.sabotageType.toUpperCase()} triggered.${ev.deadline != null ? ' Meltdown countdown started.' : ''}`;
    case 'sabotage-end':   return `Sabotage ended (${ev.reason}).`;
    case 'sabotage-spot-fixed': return `One spot of the sabotage was fixed (${ev.room}).`;
    case 'door-closed':    return `A door slammed shut (#${ev.doorId}).`;
    case 'door-opened':    return null; // too noisy to surface every auto-open
    case 'vent-enter': {
      const who = ev.playerId === obs.self.id ? 'you'
        : (obs.visiblePlayers.find(p => p.id === ev.playerId)?.name) || `player#${ev.playerId}`;
      return `You saw ${who} VENT into vent #${ev.ventId}. That player is the impostor.`;
    }
    case 'vent-exit': {
      const who = ev.playerId === obs.self.id ? 'you'
        : `player#${ev.playerId}`;
      return `You saw ${who} EMERGE from vent #${ev.ventId}. That player is the impostor.`;
    }
    case 'meeting-start': return null;            // suppress (the meeting branch takes over)
    case 'meeting-end':   return `Meeting ended.`;
    case 'voting-start':  return null;
    case 'voting-end':    return null;
    case 'game-end':      return `Game over: ${ev.winner} win (${ev.reason}).`;
    default: return null;
  }
}

function describeAction(a) {
  switch (a?.type) {
    case 'move-to-room': return `walking to ${a.room}`;
    case 'do-task':      return `working on task #${a.taskId}`;
    case 'wait':         return `waiting`;
    case 'kill-nearest': return `attempting a kill`;
    case 'report-body':  return `reporting a body`;
    case 'sabotage':     return `sabotaging (${a.sabotage})`;
    case 'fix-sabotage': return `fixing sabotage`;
    case 'close-door':   return `closing door #${a.doorId}`;
    case 'vent-to':      return `venting to #${a.ventId}`;
    case 'speak':        return `speaking in the meeting`;
    case 'vote':         return `voting`;
    default: return a?.type || 'idle';
  }
}

// ========================
// VALIDATION
// ========================

function parseAndValidate(text, obs) {
  // Strip stray markdown fencing if any model adds it.
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let obj;
  try { obj = JSON.parse(t); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.monologue !== 'string') obj.monologue = '';
  const a = obj.action;
  if (!a || typeof a !== 'object' || typeof a.type !== 'string') return null;

  // Lightweight per-action shape validation.
  switch (a.type) {
    case 'move-to-room':
      if (typeof a.room !== 'string') return null; break;
    case 'do-task':
      a.taskId = Number(a.taskId);
      if (!Number.isFinite(a.taskId)) return null;
      // Reject task ids that don't belong to this agent — keeps the LLM honest.
      if (!obs.self.tasks?.some(t => t.id === a.taskId)) return null;
      break;
    case 'speak':
      if (typeof a.text !== 'string') return null;
      // Hard cap to 12 words to enforce Discord-style brevity even when the
      // model ignores the prompt's "8 words" guidance.
      a.text = a.text.trim().split(/\s+/).slice(0, 12).join(' ').slice(0, 100);
      if (!a.text) return null;
      break;
    case 'vote':
      if (a.targetId !== 'skip') {
        a.targetId = Number(a.targetId);
        if (!Number.isFinite(a.targetId)) return null;
      }
      break;
    case 'wait':
      a.seconds = Number(a.seconds);
      if (!Number.isFinite(a.seconds) || a.seconds < 0) a.seconds = 1;
      break;
    case 'sabotage':
      if (!['lights', 'reactor', 'o2'].includes(a.sabotage)) return null;
      break;
    case 'close-door':
      a.doorId = Number(a.doorId);
      if (!Number.isInteger(a.doorId) || a.doorId < 0) return null;
      break;
    case 'vent-to':
      a.ventId = Number(a.ventId);
      if (!Number.isInteger(a.ventId) || a.ventId < 0) return null;
      break;
    case 'fix-sabotage':
    case 'kill-nearest':
    case 'report-body':
      break;
    default:
      return null;
  }
  return { monologue: obj.monologue, action: a };
}
