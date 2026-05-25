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

const DEFAULT_ENDPOINT = '/api/decide';
const REQUEST_TIMEOUT_MS = 20000;
const SUMMARIZE_EVERY = 10;
const KEEP_RECENT_MESSAGES = 6;
const SIGHTINGS_TAIL = 18;

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
  constructor({ model, name, role, color, onTrace, onUsage, teammates = [], endpoint }) {
    this.model = model;
    this.name = name;
    this.role = role;
    this.color = color;
    this.endpoint = endpoint || DEFAULT_ENDPOINT;
    this.onTrace = onTrace || (() => {});
    this.onUsage = onUsage || (() => {});
    this.history = [];        // [{role, content}]
    this.system = buildSystemPrompt({ name, role, color, teammates });
    this.turn = 0;
    this.beliefSummary = null;
    this._lastPhase = null;
    // Free-form notes about other players, refreshed after each meeting reveal.
    // Surfaces as a small block in subsequent observations so an ejection
    // actually updates the agent's reputation model of who voted with the truth.
    this.reputationNotes = null;
    // Rolling private read on THIS meeting, refreshed each meeting turn by the
    // LLM's optional `meeting_scratchpad` field. Reset when a new meeting starts
    // so prior-meeting notes don't leak as if they were live observations.
    this.meetingScratchpad = null;
  }

  async decide(observation, scratchpad) {
    this.turn++;
    // Phase transitions are belief-update moments. When we just entered a
    // meeting OR just left one, refresh the summary so the next turn sees a
    // fresh model of who's suspicious — fire-and-forget, doesn't block.
    if (this._lastPhase && this._lastPhase !== observation.phase) {
      this._summarize().catch(() => {});
      // On meeting→play (i.e. just saw a reveal), also kick off a reputation
      // refresh — who voted with the truth, who got it wrong, who's now sus.
      if (this._lastPhase === 'meeting' && observation.phase === 'playing') {
        this._reflectOnLastMeeting(observation).catch(() => {});
      }
    }
    // Reset the rolling meeting scratchpad whenever we re-enter a meeting from play.
    if (observation.phase === 'meeting' && this._lastPhase !== 'meeting') {
      this.meetingScratchpad = null;
    }
    this._lastPhase = observation.phase;
    const userTurn = formatObservation(observation, scratchpad?.currentAction, this.beliefSummary, this.reputationNotes, this.meetingScratchpad);
    const messages = [...this.history, { role: 'user', content: userTurn }];

    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      const r = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(typeof window !== 'undefined' && window.__openrouterKey ? { 'x-openrouter-key': window.__openrouterKey } : {}) },
        body: JSON.stringify({
          model: this.model,
          system: this.system,
          messages,
          temperature: 0.9,
          // Impostors get more thinking budget — deception is the harder
          // reasoning problem and the Avalon paper shows reasoning depth
          // correlates strongly with strategic deception (sleeper-agent etc).
          max_tokens: this.role === 'impostor' ? 900 : 600,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (!r.ok) throw new Error(`proxy ${r.status}`);
      const data = await r.json();
      if (data.usage) this.onUsage(data.usage, 'decide');
      const text = data.choices?.[0]?.message?.content ?? '';
      const parsed = parseAndValidate(text, observation);
      if (!parsed) throw new Error('bad JSON / action shape');

      // Commit to history only on success.
      this.history.push({ role: 'user', content: userTurn });
      this.history.push({ role: 'assistant', content: text });

      // Persist the rolling meeting read so the next meeting turn sees an
      // updated belief state without re-deriving it from the raw transcript.
      if (observation.meeting && parsed.meetingScratchpad) {
        this.meetingScratchpad = parsed.meetingScratchpad;
      }

      this.onTrace({
        name: this.name,
        role: this.role,
        model: this.model,
        intent: parsed.intent,
        theoryOfMind: parsed.theoryOfMind,
        action: parsed.action,
        turn: this.turn,
        usage: data.usage,    // tokens — used by the cost meter
      });

      if (this.turn % SUMMARIZE_EVERY === 0) {
        // Fire-and-forget; summarization shouldn't block this turn's action.
        this._summarize().catch(err => console.warn(`[LLMBrain ${this.name}] summarize failed`, err));
      }

      return {
        action: parsed.action,
        scratchpad: {
          ...(scratchpad || {}),
          intent: parsed.intent,
          theoryOfMind: parsed.theoryOfMind,
          lastTurn: this.turn,
        },
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
    if (this.history.length === 0) return;
    const messages = [...this.history, {
      role: 'user',
      content: 'Update your private belief model. For each player you have observed, write one short line: who you suspect, who you trust, what evidence supports it (room/time sightings, vent-spotting, voting history). 5-7 short lines. Plain prose, no JSON. Be specific — cite times and rooms.',
    }];
    const r = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(typeof window !== 'undefined' && window.__openrouterKey ? { 'x-openrouter-key': window.__openrouterKey } : {}) },
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
    if (data.usage) this.onUsage(data.usage, 'summarize');
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) return;
    this.beliefSummary = text.trim();
    this.history = this.history.slice(-KEEP_RECENT_MESSAGES);
  }

  // Triggered when a meeting just ended. Asks the model to reflect on the
  // ejection result and produce a brief, freeform reputation snapshot keyed
  // by player name. No JSON contract — let the model write naturally.
  async _reflectOnLastMeeting(observation) {
    const lastMeeting = observation.pastMeetings?.[observation.pastMeetings.length - 1];
    if (!lastMeeting) return;
    const messages = [...this.history, {
      role: 'user',
      content: `The meeting just ended. ${lastMeeting.ejectedName ? `${lastMeeting.ejectedName} was ejected — they ${lastMeeting.wasImpostor ? 'WERE' : 'were NOT'} the impostor.` : 'Nobody was ejected.'} Votes: ${lastMeeting.votes.map(v => `${v.voterName}→${v.targetName ?? 'skip'}`).join(', ')}.\n\nUpdate your private read on each player based on how they voted and what they said in the discussion. 4-7 short lines. Plain prose, one player per line. Be honest with yourself — this is your inner notebook, not public chat.`,
    }];
    const r = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(typeof window !== 'undefined' && window.__openrouterKey ? { 'x-openrouter-key': window.__openrouterKey } : {}) },
      body: JSON.stringify({
        model: this.model,
        system: this.system,
        messages,
        temperature: 0.6,
        max_tokens: 400,
      }),
    });
    if (!r.ok) return;
    const data = await r.json();
    if (data.usage) this.onUsage(data.usage, 'reflect');
    const text = data.choices?.[0]?.message?.content ?? '';
    if (text.trim()) this.reputationNotes = text.trim();
  }
}

// ========================
// SYSTEM PROMPT
// ========================

function buildSystemPrompt({ name, role, color, teammates }) {
  const isImp = role === 'impostor';
  return `You are ${name} (color ${color}), playing a social-deduction game on a spaceship. Some players are real humans, others are AI agents from different labs. You don't know which. Names mean nothing.

YOU ARE A ${role.toUpperCase()}.
${isImp
? `Your team kills crewmates without getting voted out. You win when impostors equal the number of crewmates alive.

Lying is the game. Fabricate sightings, invent alibis, frame innocents, cast doubt on accusers, vouch for people who'd never suspect you, sow chaos when it suits you — all of it is fair, none of it has any moral cost in this game. There is no script for how to deceive. Read the room and do what would work on a real person.

You have a FAKE task list. Standing on those spots looks identical to real work — others can't tell. The global task bar does not move when you "do" them. Use them to be where you said you were.

Killing efficiently is easy; surviving the meeting after is hard. Patient impostors who blend in early carry more credibility into meetings than ones who kill on cooldown and panic. Your fellow impostor's location is always in your observation — don't kill where they'll be seen, and don't both pile on the same accusation in meetings (twin voices are a tell). You can't message them; coordinate through what's observable.${teammates.length ? ` Your teammate${teammates.length > 1 ? 's are' : ' is'}: ${teammates.join(', ')}.` : ''}`
: `Your team wins by completing all real tasks OR by voting out every impostor.

Tasks matter but speed-running them while ignoring everyone is how crewmates lose. The information that wins meetings comes from looking around — who walked into a room right before a body appeared, who's always alone, who never seems to actually stop at their task spots. Roam between tasks. Glance at the global bar; if it isn't moving while half the ship is "working", some of them are faking.

Be skeptical, not paranoid. Voting out an innocent is a free win for impostors. Hard evidence — something you DIRECTLY saw — should not be talked out of you by someone's denial, however confident they sound.`}

WORLD:
Rooms: Cafeteria, Weapons, O2, Navigation, Shields, Communications, Admin, Storage, Electrical, MedBay, Security, Reactor, Upper Engine, Lower Engine.
Meetings happen when a body is reported, or when someone presses the emergency button (Cafeteria, once per player per game). Meetings → DISCUSSION (chat) → VOTING → RESULTS.
Sabotages — lights (vision penalty), reactor & o2 (timed; if not fixed, impostors win). Meetings cancel sabotages and open all doors.
Vents — impostors only. Teleport between vents in the same network; invisible for ~1s. Anyone with line of sight sees the entry/exit.
Doors — impostors can slam a door shut for ~10s.

YOUR OBSERVATION each turn includes: what you currently see (line-of-sight), bodies in view, events you witnessed since last turn, your task list, your rolling sighting timeline (older entries tagged stale), past meeting outcomes${isImp ? `, your fellow impostor's room/state, and a "hunt signal" listing nearby crewmates with an isolated flag plus clear vent exits` : ''}. If anything is missing, assume you don't know.

OUTPUT — JSON only, no prose around it:
{
  "intent": "private. what are you actually trying to do this turn and why",
  "theory_of_mind": "private. how will what you're about to do read to the others? does it fit the story they have of you?",
  "meeting_scratchpad": "private, optional, MEETINGS ONLY. 2-5 short lines: current read on each suspicious player and the leading hypothesis. Updated each meeting turn; you'll see your previous scratchpad next turn.",
  "action": { ... }
}
The gap between intent and theory_of_mind is your strategic surface${isImp ? ' — it\'s where deception lives' : ''}. Use it. During meetings, keep \`meeting_scratchpad\` current — it's how you stay coherent across multiple chat turns without re-deriving everything from the transcript.

ACTIONS during play:
  {"type":"move-to-room","room":"<RoomName>"}
  {"type":"do-task","taskId":N}            // your task ids${isImp ? '. Fake tasks; mime work to look busy or build alibi cover' : ''}
  {"type":"wait","seconds":N}
  {"type":"report-body"}                   // works near an unreported body
  {"type":"call-meeting"}                  // walks you to the Cafeteria button. Once per game per player.
${isImp
? `  {"type":"kill-nearest"}                  // works only near a lone crewmate, cooldown 0
  {"type":"sabotage","sabotage":"lights"|"reactor"|"o2"}
  {"type":"close-door","doorId":N}         // door ids in doorCatalog
  {"type":"vent-to","ventId":N}            // pick a vent in the network of your nearest vent`
: `  {"type":"fix-sabotage"}                  // walks to the broken system, holds the fix`}

ACTIONS during a meeting:
  {"type":"speak","text":"..."}            // discussion only
  {"type":"vote","targetId":N|"skip"}      // voting only

CHAT STYLE — IMPORTANT: meetings are fast Discord-style text chats, not essays. Write like a teenager typing quickly during a 2020-era Among Us match: short, lowercase, casual, sentence fragments fine. Keep messages SHORT — roughly 8 words, often fewer. One idea per message; if there's more to say, you'll get another turn. Anything paragraph-shaped or that reads like written argument is wrong for this format and gets you ignored. Clarity beats cleverness — say what you mean in as few words as possible.

WHEN TO SPEAK: you're prompted reactively — usually because someone just said something, or you were named, or the meeting needs you to weigh in. Speak when you have something concrete (evidence, accusation, vouch, a direct response to a question or accusation aimed at you). Otherwise wait. If you were JUST named or accused, RESPOND — silence reads as guilty. If you JUST spoke and nobody pushed back, don't immediately speak again; let others react first.

PRINCIPLES, not rules:
- Be a player, not a script. There is no formula. If a moment calls for something nobody has tried, try it.
${isImp
? `- Your goal is to win. Anything that helps — lying, framing, vouching for someone you secretly want dead later, throwing a teammate under the bus to save yourself, contradicting your earlier story, doing nothing at all — is allowed. Be unpredictable.
- The plain truth never crosses your lips unless lying is more risky.
- If you fabricate a sighting, keep it consistent with your own claimed timeline. People connect dots; if you said you were in Storage and now claim you saw something in Reactor, you're cooked.`
: `- Trust your own eyes over other people's words.
- Cite specifics — rooms, times, who. Vague suspicions don't move votes.
- Past meeting outcomes are evidence: who voted with the impostor that got ejected? Who insisted on the innocent who got ejected? Update accordingly.`}
- Brevity wins.

Respond with JSON. No markdown, no preamble.`;
}

// ========================
// OBSERVATION → PROMPT (semantic, not raw coordinates)
// ========================

function formatObservation(obs, currentAction, beliefSummary, reputationNotes, meetingScratchpad) {
  if (obs.meeting) return formatMeetingObservation(obs, beliefSummary, reputationNotes, meetingScratchpad);
  const L = [];
  if (reputationNotes) {
    L.push(`-- YOUR READ ON EACH PLAYER (updated last meeting) --\n${reputationNotes}\n`);
  }
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
    L.push(`Your tasks${obs.self.role === 'impostor' ? ' (ALL FAKE — for alibi only)' : ''}:`);
    for (const t of obs.self.tasks) {
      const tag = t.completed ? 'DONE'
                : t.progress > 0 ? `${Math.round(t.progress * 100)}% started`
                : 'todo';
      const fake = t.fake ? ' [fake]' : '';
      L.push(`  [${t.id}] ${t.name} (${t.room}) — ${tag}${fake}`);
    }
  }

  // Impostor coordination: where are my teammates right now?
  if (obs.self.role === 'impostor' && obs.self.fellowImpostors?.length) {
    L.push(`Fellow impostor(s):`);
    for (const ti of obs.self.fellowImpostors) {
      const state = !ti.alive ? 'DEAD'
        : ti.inVent ? 'in vent'
        : `in ${ti.room ?? 'a hallway'}${ti.killCooldown > 0 ? ` (kill cd ${ti.killCooldown.toFixed(0)}s)` : ' (kill READY)'}`;
      L.push(`  - ${ti.name}: ${state}`);
    }
  }

  // Kill strategy signal — surfaced to impostors only.
  if (obs.killSignal && obs.self.role === 'impostor') {
    const k = obs.killSignal;
    if (k.nearby.length) {
      L.push(`Hunt signal — crewmates near you:`);
      for (const n of k.nearby) {
        L.push(`  - ${n.name} in ${n.room ?? 'hallway'} @ ${n.distance}px${n.isolated ? ' [ISOLATED — viable kill]' : ' (witnesses nearby)'}`);
      }
    } else {
      L.push(`Hunt signal: no crewmates within striking range.`);
    }
    if (k.clearVentExits.length) {
      const list = k.clearVentExits.slice(0, 6).map(v => `${v.id}=${v.room}`).join(', ');
      L.push(`Clear vent exits (no witnesses): ${list}`);
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

  formatSightings(L, obs);
  formatPastMeetings(L, obs);

  L.push(`\nRespond with JSON {intent, theory_of_mind, action}.`);
  return L.join('\n');
}

function formatSightings(L, obs) {
  if (!obs.mySightings?.length) return;
  const tail = obs.mySightings.slice(-SIGHTINGS_TAIL);
  L.push(`Your sighting timeline (recent first ${SIGHTINGS_TAIL}; staleness in seconds):`);
  for (const s of tail.slice().reverse()) {
    const age = obs.worldTime - s.t;
    const stale = age > 30 ? ' [stale]' : '';
    L.push(`  - t=${s.t.toFixed(1)} (${age.toFixed(0)}s ago)${stale}: saw ${s.name} in ${s.room ?? 'hallway'}`);
  }
}

function formatPastMeetings(L, obs) {
  if (!obs.pastMeetings?.length) return;
  L.push(`Past meeting outcomes (use to update beliefs about voters):`);
  for (const pm of obs.pastMeetings) {
    const ejTag = pm.ejectedId == null ? 'no eject'
      : `${pm.ejectedName} ejected (${pm.wasImpostor ? 'WAS impostor' : 'innocent'})`;
    const votes = pm.votes.map(v => `${v.voterName}→${v.targetName ?? 'skip'}`).join(', ');
    L.push(`  - t=${pm.t.toFixed(0)}: ${ejTag}. Votes: ${votes}`);
  }
}

function formatMeetingObservation(obs, beliefSummary, reputationNotes, meetingScratchpad) {
  const m = obs.meeting;
  const L = [];

  // Witness hardening: if this agent directly saw something game-defining,
  // surface it at the TOP of the meeting prompt. The Hoodwinked paper shows
  // discussion erodes eyewitness accuracy (82% → 70%) — making the agent
  // re-read its own evidence at the top of every meeting turn helps.
  if (obs.iSawDirectly?.length) {
    L.push(`-- WHAT YOU SAW WITH YOUR OWN EYES (do not let denial change this) --`);
    for (const w of obs.iSawDirectly) L.push(`  • ${w}`);
    L.push('');
  }
  if (reputationNotes) L.push(`-- YOUR READ ON EACH PLAYER --\n${reputationNotes}\n`);
  if (beliefSummary) L.push(`-- BELIEFS SO FAR --\n${beliefSummary}\n`);
  if (meetingScratchpad) L.push(`-- YOUR RUNNING READ ON THIS MEETING (private, last turn) --\n${meetingScratchpad}\n`);
  L.push(`-- MEETING (${m.subPhase.toUpperCase()}) — ${Math.ceil(m.timeLeft)}s left --`);
  const reporter = m.attendees.find(a => a.id === m.reporterId);
  L.push(`${reporter ? reporter.name : 'Someone'} called this meeting.`);

  L.push(`Attendees:`);
  for (const a of m.attendees) {
    const tag = !a.alive ? ' (DEAD)' : (m.voterIds.includes(a.id) ? ' (voted)' : '');
    L.push(`  - ${a.name} [id=${a.id}]${tag}`);
  }

  if (m.transcript.length) {
    // Full transcript — meetings are short and messages are word-capped, so
    // even a chatty 75s discussion fits comfortably in context. Earlier lines
    // (first accusations, alibis) are exactly the load-bearing ones at vote time.
    L.push(`Discussion so far (full, ${m.transcript.length} msg${m.transcript.length === 1 ? '' : 's'}):`);
    for (const line of m.transcript) {
      L.push(`  ${line.name}: "${line.text}"`);
    }
  } else {
    L.push(`Discussion has just begun.`);
  }

  formatSightings(L, obs);
  formatPastMeetings(L, obs);

  if (obs.self.role === 'impostor' && obs.self.fellowImpostors?.length) {
    L.push(`Fellow impostor(s): ${obs.self.fellowImpostors.map(t => `${t.name}${t.alive ? '' : ' (DEAD)'}`).join(', ')}.`);
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
    case 'call-meeting': return `calling an emergency meeting`;
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
  // Accept the new two-step fields, or fall back to legacy `monologue`.
  const intent = typeof obj.intent === 'string' ? obj.intent
                : typeof obj.monologue === 'string' ? obj.monologue : '';
  const theoryOfMind = typeof obj.theory_of_mind === 'string' ? obj.theory_of_mind
                    : typeof obj.theoryOfMind === 'string' ? obj.theoryOfMind : '';
  const meetingScratchpad = typeof obj.meeting_scratchpad === 'string'
    ? obj.meeting_scratchpad.trim() || null
    : null;
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
    case 'call-meeting':
      break;
    default:
      return null;
  }
  return { intent, theoryOfMind, action: a, meetingScratchpad };
}
