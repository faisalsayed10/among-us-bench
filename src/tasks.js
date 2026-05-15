// ========================
// TASKS
// ========================
// Simple timer-based tasks: stand on the task spot, hold E for TASK_DURATION
// seconds. Each crewmate gets N task spots assigned from the global pool.

import { tasks as TASK_DEFS } from './map-data.js';

export const TASK_INTERACT_RADIUS = 30;
// Longer task duration means crewmates can't speed-run their checklist and
// have to actually stand vulnerable for a meaningful time. Also slows the
// game so deception has room to breathe.
export const TASK_DURATION = 8; // seconds of hold-E to complete

let nextTaskInstanceId = 1;

/** Shuffle utility (Fisher–Yates). */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Assign `tasksPerPlayer` task definitions to each crewmate.
 * Impostors don't receive real tasks (fake-task UI comes later).
 * Returns the task-instance array.
 */
export function assignTasksToPlayers(players, tasksPerPlayer = 4) {
  const instances = [];
  for (const p of players) {
    const picks = shuffle(TASK_DEFS).slice(0, tasksPerPlayer);
    const fake = p.role === 'impostor';
    for (const def of picks) {
      instances.push({
        id: nextTaskInstanceId++,
        playerId: p.id,
        def,                       // {x, y, room, type, name}
        progress: 0,               // 0..1
        completed: false,
        fake,                      // impostor's fake-task list — looks identical, never completes
        lastProgressedAt: -Infinity, // sim time of last progress tick (for decay)
      });
    }
  }
  return instances;
}

/** Tasks belonging to a given player. */
export function tasksForPlayer(allTasks, playerId) {
  return allTasks.filter(t => t.playerId === playerId);
}

/** Distance check against task spot. */
export function isAtTask(player, task) {
  const dx = task.def.x - player.x;
  const dy = task.def.y - player.y;
  return dx * dx + dy * dy <= TASK_INTERACT_RADIUS * TASK_INTERACT_RADIUS;
}

/** Find this player's nearest in-range, incomplete task. */
export function findActiveTask(allTasks, player) {
  for (const t of allTasks) {
    if (t.playerId !== player.id || t.completed) continue;
    if (isAtTask(player, t)) return t;
  }
  return null;
}

/** Global completion ratio across all assigned tasks. */
export function globalProgress(allTasks) {
  const real = allTasks.filter(t => !t.fake);
  if (real.length === 0) return 0;
  let sum = 0;
  for (const t of real) sum += t.completed ? 1 : t.progress;
  return sum / real.length;
}
