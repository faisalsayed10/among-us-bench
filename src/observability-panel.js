// ========================
// OBSERVABILITY PANEL
// ========================
// Side panel showing each agent's last monologue, current action, and
// (during meetings) what they're about to say. Roles can be hidden to play
// "blind" — useful if the human wants to actually deduce.
//
// State sources:
//   - game.players                 → names, colors, alive/dead, role
//   - game.controllers             → current action (per AgentController)
//   - window.__agentTraces (Map)   → last LLM monologue + action trace

export class ObservabilityPanel {
  constructor(game) {
    this.game = game;
    this.root        = document.getElementById('agent-panel');
    this.cardsEl     = document.getElementById('agent-cards');
    this.toggleRoles = document.getElementById('toggle-roles');
    this.togglePanel = document.getElementById('toggle-panel');
    this.showRoles = true;
    this.collapsed = false;

    this.toggleRoles.addEventListener('click', () => {
      this.showRoles = !this.showRoles;
      this.toggleRoles.textContent = this.showRoles ? 'HIDE ROLES' : 'SHOW ROLES';
    });
    this.togglePanel.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.root.classList.toggle('collapsed', this.collapsed);
      this.togglePanel.textContent = this.collapsed ? '+' : '−';
    });

    this._lastRender = 0;
  }

  tick(now) {
    // Throttle: 5fps is plenty. Cuts DOM churn while the LLM thinks.
    if (this.collapsed) return;
    if (now - this._lastRender < 200) return;
    this._lastRender = now;

    const local = this.game.getLocalPlayer();
    const traces = window.__agentTraces || new Map();
    const gameEnded = this.game.phase === 'ended';

    const cards = this.game.players.map(p => {
      const isSelf = local && p.id === local.id;
      const controller = this.game.controllers.get(p.id);
      const action = controller?.action;

      // Roles: shown if the user chose to, OR always at game-end (the reveal
      // moment is the whole point — at that point hiding is silly).
      const showRoleNow = this.showRoles || gameEnded;
      const roleLabel = showRoleNow
        ? (p.role === 'impostor' ? 'IMP' : 'CREW')
        : '???';
      const roleClass = showRoleNow ? p.role : 'hidden';

      const traceList = traces.get(p.name) || [];
      const lastTrace = traceList[traceList.length - 1];
      const monologue = lastTrace?.monologue || '';
      const error = lastTrace?.error || '';

      const actionLabel = isSelf ? '(you — manual)' : describeAction(action);

      const meetingLine = renderMeetingTag(this.game, p);

      return `<div class="agent-card ${p.alive ? '' : 'dead'} ${isSelf ? 'self' : ''}">
        <div class="ac-head">
          <div class="ac-avatar" style="background:${p.color}"></div>
          <div class="ac-name">${escapeHtml(p.name)}${isSelf ? ' (you)' : ''}</div>
          <div class="ac-role ${roleClass}">${roleLabel}</div>
          ${p.alive ? '' : '<div class="ac-dead">DEAD</div>'}
        </div>
        ${action || isSelf ? `<div class="ac-action tagged">${escapeHtml(actionLabel)}</div>` : ''}
        ${monologue ? `<div class="ac-monologue">${escapeHtml(monologue)}</div>` : ''}
        ${meetingLine}
        ${error ? `<div class="ac-error">⚠ ${escapeHtml(error)}</div>` : ''}
      </div>`;
    }).join('');

    this.cardsEl.innerHTML = cards;
  }
}

function describeAction(a) {
  if (!a) return 'idle';
  switch (a.type) {
    case 'move-to-room': return `walking to ${a.room}`;
    case 'do-task':      return `working on task #${a.taskId}`;
    case 'kill-nearest': return 'attempting kill';
    case 'report-body':  return 'reporting body';
    case 'wait':         return `waiting (${a.seconds}s)`;
    case 'speak':        return `speaking`;
    case 'vote':         return `voting`;
    default:             return a.type;
  }
}

function renderMeetingTag(game, player) {
  if (game.phase !== 'meeting') return '';
  const m = game.meeting;
  if (!m) return '';
  // Show their last spoken line during discussion.
  if (m.subPhase === 'discussion') {
    const lastSaid = [...m.transcript].reverse().find(t => t.playerId === player.id);
    if (lastSaid) return `<div class="ac-meeting">"${escapeHtml(lastSaid.text)}"</div>`;
  }
  // Show "voted" status during voting (target hidden until results).
  if (m.subPhase === 'voting') {
    if (m.votes.has(player.id)) return `<div class="ac-meeting">voted</div>`;
  }
  // Show their vote at results.
  if (m.subPhase === 'results') {
    const target = m.votes.get(player.id);
    if (target === 'skip') return `<div class="ac-meeting">voted: skip</div>`;
    if (target != null) {
      const t = game.players.find(p => p.id === target);
      if (t) return `<div class="ac-meeting">voted: ${escapeHtml(t.name)}</div>`;
    }
  }
  return '';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
