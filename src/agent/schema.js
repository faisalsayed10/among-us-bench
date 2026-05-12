// ========================
// AGENT SCHEMA
// ========================
// Shared types for the agent layer. Any brain — scripted, LLM-backed, or
// remote — consumes an Observation and returns an Action. The AgentController
// executes the action tick-by-tick and re-asks the brain when it completes
// or when a significant event interrupts it.
//
// Keep this file pure: no game-state imports, no side effects. It is the
// contract between game and brain.

/**
 * @typedef {Object} TaskView
 * @property {number} id
 * @property {string} name
 * @property {string} room
 * @property {number} x
 * @property {number} y
 * @property {number} progress      // 0..1
 * @property {boolean} completed
 */

/**
 * @typedef {Object} VisiblePlayer
 * @property {number} id
 * @property {string} name
 * @property {string} color
 * @property {string|null} room
 * @property {number} x
 * @property {number} y
 * @property {boolean} alive
 * @property {'walking'|'idle'|'doing-task'} activity
 */

/**
 * @typedef {Object} VisibleBody
 * @property {number} bodyId
 * @property {number} victimId
 * @property {string} victimName
 * @property {string|null} room
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {Object} ObservedEvent
 * Filtered slice of GameState.events that this agent could plausibly perceive.
 * @property {string} type          // 'kill' | 'body-reported' | 'meeting-start' | 'task-complete' | ...
 * @property {number} t             // sim time
 * @property {any} [details]        // type-specific payload (preserved from emit)
 */

/**
 * @typedef {Object} Observation
 * @property {Object} self
 * @property {number} self.id
 * @property {string} self.name
 * @property {'crewmate'|'impostor'} self.role
 * @property {boolean} self.alive
 * @property {{x:number,y:number,room:string|null}} self.position
 * @property {number} self.killCooldown          // seconds, 0 if not impostor
 * @property {TaskView[]} self.tasks             // empty for impostor
 * @property {number} worldTime
 * @property {'playing'|'meeting'|'ended'} phase
 * @property {VisiblePlayer[]} visiblePlayers
 * @property {VisibleBody[]} visibleBodies
 * @property {ObservedEvent[]} recentEvents      // since last observation
 * @property {number} globalTaskProgress         // 0..1 (public info in Among Us)
 */

// ========================
// ACTIONS
// ========================
// Actions are high-level intents the brain expresses; the executor decomposes
// them into per-frame Player intent + tap-fire calls.
//
// Each action carries enough info that an LLM-generated JSON object can be
// validated and run without further context.

/** Move to the centroid of a named room (uses adjacency-graph routing). */
export const moveToRoom = (room) => ({ type: 'move-to-room', room });

/** Walk to an assigned task and hold E until complete. */
export const doTask = (taskId) => ({ type: 'do-task', taskId });

/** Idle in place for N seconds (used for "looking innocent" or pacing). */
export const wait = (seconds) => ({ type: 'wait', seconds });

/** Impostor: kill the nearest crewmate if in range and off cooldown. */
export const killNearest = () => ({ type: 'kill-nearest' });

/** Report the nearest unreported body if in range. */
export const reportBody = () => ({ type: 'report-body' });

/** Impostor: trigger a sabotage. 'lights' or 'reactor'. */
export const sabotage = (kind) => ({ type: 'sabotage', sabotage: kind });

/** Crewmate: walk to the active sabotage's fix spot and hold until repaired. */
export const fixSabotage = () => ({ type: 'fix-sabotage' });

/** Impostor: slam a specific door shut for ~10s. doorId is from observation. */
export const closeDoor = (doorId) => ({ type: 'close-door', doorId });

// --- Future actions (documented; executor stubs below) ---
/** Impostor: travel through the vent network to a destination room. */
export const ventTo = (room) => ({ type: 'vent-to', room });

/** Press the emergency button (must be in Cafeteria). */
export const callMeeting = () => ({ type: 'call-meeting' });

/** Meetings: contribute to the discussion transcript. */
export const speak = (text) => ({ type: 'speak', text });

/** Meetings: cast a vote (or 'skip'). */
export const vote = (targetId) => ({ type: 'vote', targetId });

/**
 * @typedef {Object} Action
 * @property {'move-to-room'|'do-task'|'wait'|'kill-nearest'|'report-body'|'vent-to'|'call-meeting'|'speak'|'vote'} type
 */

/**
 * The contract every brain implements.
 *
 * @typedef {Object} Brain
 * @property {(obs: Observation, scratchpad: any) => {action: Action, scratchpad: any}} decide
 */
