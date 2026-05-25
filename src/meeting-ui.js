// ========================
// MEETING UI
// ========================
// Manages the HTML overlay that appears during a meeting. Renders the
// player grid, voting buttons, chat transcript, the human chat input,
// and the results banner. State is read from GameState each frame while
// visible — no event subscriptions; the rendering cost is negligible.

export class MeetingUI {
  constructor(game) {
    this.game = game;
    this.root        = document.getElementById('meeting');
    this.subtitle    = document.getElementById('meeting-subtitle');
    this.phaseName   = document.getElementById('phase-name');
    this.phaseTimer  = document.getElementById('phase-timer');
    this.grid        = document.getElementById('players-grid');
    this.transcript  = document.getElementById('transcript');
    this.chatForm    = document.getElementById('chat-form');
    this.chatInput   = document.getElementById('chat-input');
    this.chatSend    = this.chatForm.querySelector('.chat-send');
    this.resultsBox  = document.getElementById('results-banner');

    this._wasVisible = false;
    this._lastTranscriptLen = -1;
    this._lastSubPhase = null;
    this._lastGridSig = '';

    this.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const local = this.game.getLocalPlayer();
      if (!local) return;
      const text = this.chatInput.value;
      if (this.game.speak(local.id, text)) this.chatInput.value = '';
    });

    // Event delegation: the grid re-renders frequently, so per-button listeners
    // get destroyed before clicks can fire. The grid itself is stable.
    this.grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.vote-btn');
      if (!btn) return;
      const local = this.game.getLocalPlayer();
      if (!local) return;
      const t = btn.dataset.target;
      const targetId = t === 'skip' ? 'skip' : parseInt(t, 10);
      this.game.castVote(local.id, targetId);
    });
  }

  /** Called each frame from the game loop. */
  tick() {
    const visible = this.game.phase === 'meeting';
    if (visible !== this._wasVisible) {
      this.root.classList.toggle('show', visible);
      this._wasVisible = visible;
      if (visible) {
        this._lastTranscriptLen = -1;
        this._lastSubPhase = null;
        this._lastGridSig = '';
      }
    }
    if (!visible) return;

    const m = this.game.meeting;
    if (!m) return;

    // Subtitle: who reported whom.
    const reporter = this.game.players.find(p => p.id === m.reporterId);
    const body = m.bodyId != null ? this.game.bodies.find(b => b.id === m.bodyId) : null;
    if (body) this.subtitle.textContent = `${reporter?.name ?? '?'} reported ${body.name}'s body.`;
    else this.subtitle.textContent = `${reporter?.name ?? '?'} called the meeting.`;

    // Phase chip + timer
    const label = m.subPhase === 'discussion' ? 'DISCUSSION'
                : m.subPhase === 'voting'     ? 'VOTING'
                                              : 'RESULTS';
    this.phaseName.textContent = label;
    this.phaseName.className = `phase-name ${m.subPhase}`;
    this.phaseTimer.textContent = `${Math.ceil(m.subPhaseEndsAt - this.game.time)}s`;

    // Sub-phase transitions: clear results, focus input, etc.
    if (m.subPhase !== this._lastSubPhase) {
      this._lastSubPhase = m.subPhase;
      this._renderGrid();
      this._renderResults();
      if (m.subPhase === 'discussion') {
        setTimeout(() => this.chatInput.focus(), 50);
      }
    }

    // Chat input enabled only during discussion + local player alive.
    const local = this.game.getLocalPlayer();
    const canType = m.subPhase === 'discussion' && local && local.alive;
    this.chatInput.disabled = !canType;
    this.chatSend.disabled = !canType;
    this.chatInput.placeholder = canType ? 'Discuss...'
      : !local?.alive ? "You're dead — observing only."
      : m.subPhase === 'voting' ? 'Voting in progress…'
      : 'Results…';

    // Transcript: only re-render if it grew.
    if (m.transcript.length !== this._lastTranscriptLen) {
      this._lastTranscriptLen = m.transcript.length;
      this._renderTranscript();
    }

    // Grid re-renders every frame for vote-count updates & timer-driven UI.
    this._renderGrid();
    this._renderResults();
  }

  _renderTranscript() {
    const m = this.game.meeting;
    const models = window.__agentModels;
    const html = m.transcript.map(t => {
      const author = escapeHtml(t.name);
      const text = escapeHtml(t.text);
      const color = colorForPlayer(this.game, t.playerId);
      const modelLabel = models?.get(t.name)?.label;
      const modelHtml = modelLabel ? ` <span class="model-tag">[${escapeHtml(modelLabel)}]</span>` : '';
      return `<div class="chat-line"><span class="author" style="color:${color}">${author}${modelHtml}:</span><span class="text">${text}</span></div>`;
    }).join('');
    this.transcript.innerHTML = html || `<div class="chat-line system"><span class="text">Discussion begins.</span></div>`;
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  _renderGrid() {
    const m = this.game.meeting;
    const local = this.game.getLocalPlayer();

    // Skip re-render if visible state is identical — repeatedly replacing
    // innerHTML kills mid-click vote buttons (mousedown lands on an element
    // that gets destroyed before mouseup, so `click` never fires).
    const sig = [
      m.subPhase,
      local?.id ?? '',
      local?.alive ? 1 : 0,
      [...m.votes.keys()].sort().join(','),
      // Vote targets are only revealed in results, so they only affect rendering then.
      m.subPhase === 'results' ? [...m.votes.entries()].map(([k, v]) => `${k}:${v}`).sort().join(',') : '',
      this.game.players.map(p => `${p.id}:${p.alive ? 1 : 0}`).join('|'),
    ].join('§');
    if (sig === this._lastGridSig) return;
    this._lastGridSig = sig;
    const inVoting = m.subPhase === 'voting';
    const inResults = m.subPhase === 'results';
    const localCanVote = inVoting && local && local.alive && !m.votes.has(local.id);

    // Count votes per target (only revealed at results).
    const votesByTarget = new Map();
    if (inResults) {
      for (const target of m.votes.values()) {
        votesByTarget.set(target, (votesByTarget.get(target) || 0) + 1);
      }
    }

    // Players
    const cards = this.game.players.map(p => {
      const isSelf = local && p.id === local.id;
      const hasVoted = m.votes.has(p.id);

      let statusHtml = '';
      if (!p.alive) statusHtml = `<span class="player-status dead">DEAD</span>`;
      else if (inVoting && hasVoted) statusHtml = `<span class="player-status voted">VOTED</span>`;

      let actionHtml = '';
      if (localCanVote && p.alive && !isSelf) {
        actionHtml = `<button class="vote-btn" data-target="${p.id}">VOTE</button>`;
      }

      let tallyHtml = '';
      if (inResults) {
        const count = votesByTarget.get(p.id) || 0;
        if (count > 0) {
          tallyHtml = '<div class="vote-tally">' + Array.from({length: count}, () =>
            `<div class="vote-dot" style="background:${p.color}"></div>`).join('') + '</div>';
        }
      }

      return `<div class="player-card${!p.alive ? ' dead' : ''}${isSelf ? ' self' : ''}">
        <div class="player-avatar" style="background:${p.color}"></div>
        <div style="flex:1; min-width:0;">
          <div class="player-name">${escapeHtml(p.name)}${isSelf ? ' (you)' : ''}</div>
          ${statusHtml}${tallyHtml}
        </div>
        ${actionHtml}
      </div>`;
    }).join('');

    // Skip option
    let skipHtml = '';
    if (localCanVote) {
      skipHtml = `<div class="player-card skip-card">
        <button class="vote-btn" data-target="skip">SKIP VOTE</button>
      </div>`;
    } else if (inResults) {
      const skipCount = votesByTarget.get('skip') || 0;
      if (skipCount > 0) {
        const dots = Array.from({length: skipCount}, () =>
          `<div class="vote-dot" style="background:#909a9f"></div>`).join('');
        skipHtml = `<div class="player-card skip-card">
          <div style="color:#909a9f; font-weight:bold; letter-spacing:1px;">SKIP</div>
          <div class="vote-tally">${dots}</div>
        </div>`;
      }
    }

    this.grid.innerHTML = cards + skipHtml;
    // Click handling is via event delegation on this.grid (set up in ctor).
  }

  _renderResults() {
    const m = this.game.meeting;
    if (m.subPhase !== 'results') {
      this.resultsBox.style.display = 'none';
      return;
    }
    this.resultsBox.style.display = 'block';
    if (m.ejectedId == null) {
      this.resultsBox.className = 'results-banner';
      this.resultsBox.innerHTML = `<div class="results-headline">No one was ejected.</div>
        <div class="results-reveal">(Tied or skipped.)</div>`;
      return;
    }
    const ej = this.game.players.find(p => p.id === m.ejectedId);
    if (!ej) return;
    const wasImpostor = m.ejectedWasImpostor;
    this.resultsBox.className = `results-banner ${wasImpostor ? 'impostor' : 'crewmate'}`;
    this.resultsBox.innerHTML = `<div class="results-headline">${escapeHtml(ej.name)} was ejected.</div>
      <div class="results-reveal">${wasImpostor ? 'They were the Impostor.' : 'They were not the Impostor.'}</div>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function colorForPlayer(game, playerId) {
  const p = game.players.find(pp => pp.id === playerId);
  return p ? p.color : '#d0d6dc';
}
