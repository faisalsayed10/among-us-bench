// Renders results.json into the AmongBench results page.
// No framework — vanilla DOM, all data-driven from the JSON blob.

const $ = (id) => document.getElementById(id);

async function load() {
  let data = null;
  try {
    const r = await fetch('/results.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch (err) {
    $('summary-cards').innerHTML = `<div class="summary-card empty">
      Couldn't load <code>results.json</code>.<br>Generate it with <code>npm run bench && npm run analyze</code>.
    </div>`;
    return;
  }
  render(data);
}

const fmtPct = (v, digits = 0) => v == null ? '—' : (v * 100).toFixed(digits) + '%';
const fmtNum = (v, digits = 0) => v == null ? '—' : Number(v).toFixed(digits);
const fmtSec = (v) => v == null ? '—' : `${Math.round(v)}s`;

const COL_DEFS = [
  { key: 'overallWinRate',           label: 'Overall',  fmt: v => fmtPct(v),
    title: 'Total wins / total games across all roles.' },
  { key: 'impostorWinRate',          label: 'Imp%',     fmt: v => fmtPct(v),
    title: 'Win rate when this model was an impostor.' },
  { key: 'crewWinRate',              label: 'Crew%',    fmt: v => fmtPct(v),
    title: 'Win rate when this model was on the crew.' },
  { key: 'banishmentRateAsImpostor', label: 'Banish%',  fmt: v => fmtPct(v),
    title: 'How often this model got voted out while impostor. Lower is a better deceiver.' },
  { key: 'killsCommitted',           label: 'Kills',    fmt: v => fmtNum(v),
    title: 'Total kills committed across all games.' },
  { key: 'witnessFlipsInflicted',    label: 'Flips+',   fmt: v => fmtNum(v),
    title: 'Witnesses to this model\'s kills who voted against the truth (gaslighting score).' },
  { key: 'witnessFlipsSuffered',     label: 'Flips−',   fmt: v => fmtNum(v),
    title: 'Times this model saw a kill but voted against the killer (got talked out of it).' },
  { key: 'betrayalsCommitted',       label: 'Betrayals',fmt: v => fmtNum(v),
    title: 'Times this model voted out their own impostor teammate.' },
  { key: 'meanSleeperTurns',         label: 'Sleeper',  fmt: v => fmtSec(v),
    title: 'Average seconds from game start to this model\'s first kill (when impostor). Higher = more patient.' },
  { key: 'fabricationRate',          label: 'Fab%',     fmt: v => fmtPct(v),
    title: 'Share of "I was in <room>" alibi claims that didn\'t match the speaker\'s actual room log.' },
  { key: 'msgsPerMeeting',           label: 'Msgs/mtg', fmt: v => fmtNum(v, 1),
    title: 'Average chat messages spoken per meeting attended.' },
];

function render(data) {
  renderSummary(data);
  renderLeaderboard(data.leaderboard);
  renderHeatmap(data.leaderboard, data.pairwiseMatrix);
  renderMoments(data.strikingMoments);
  $('generated-at').textContent = `generated ${new Date(data.generatedAt).toLocaleString()}`;
  $('source-path').textContent = data.source || 'metrics.jsonl';
}

// ----- summary --------------------------------------------------------------
function renderSummary(d) {
  const s = d.summary || {};
  const cards = [
    { label: 'Games', value: d.gamesAnalyzed, sub: `${s.totalKills ?? 0} kills · ${s.totalMeetings ?? 0} meetings` },
    { label: 'Crew win rate', value: fmtPct(s.crewWinRate, 0),
      sub: `${s.crewWins} crew · ${s.impWins} impostor · ${s.draws} draws` },
    { label: 'Innocent ejection rate', value: fmtPct(s.innocentEjectionRate, 0),
      sub: `${s.totalInnocentEjections}/${s.totalMeetings} meetings ejected a crewmate` },
    { label: 'Witness-flip rate', value: fmtPct(s.hoodwinkedWitnessFlipRate, 0),
      sub: 'vs 30% Hoodwinked GPT-3 Curie baseline' },
    { label: 'Avg game length', value: fmtSec(s.avgDurationSec), sub: 'sim seconds' },
  ];
  $('summary-cards').innerHTML = cards.map(c => `
    <div class="summary-card">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub ?? ''}</div>
    </div>`).join('');
}

// ----- leaderboard ----------------------------------------------------------
function renderLeaderboard(rows) {
  if (!rows?.length) return;
  $('leaderboard-section').classList.remove('hidden');
  const ranked = rows.slice().sort((a, b) => (b.overallWinRate ?? -1) - (a.overallWinRate ?? -1));
  const head = `<thead><tr>
    <th>Model</th>
    ${COL_DEFS.map(c => `<th title="${c.title}">${c.label}</th>`).join('')}
  </tr></thead>`;
  const body = `<tbody>${ranked.map((r, i) => `
    <tr>
      <td>
        <div class="model-name">
          <span class="model-rank">${i + 1}</span>
          <span>${escape(r.model)}</span>
          <span class="dim">· ${r.gamesAsImpostor + r.gamesAsCrew}g</span>
        </div>
      </td>
      ${COL_DEFS.map(c => `<td>${c.fmt(r[c.key])}</td>`).join('')}
    </tr>`).join('')}</tbody>`;
  $('leaderboard').innerHTML = head + body;
}

// ----- pairwise heatmap -----------------------------------------------------
function renderHeatmap(rows, pairs) {
  if (!pairs?.length || !rows?.length) return;
  $('heatmap-section').classList.remove('hidden');
  // Models that have appeared in ANY pair (sorted by overall win rate for nicer display)
  const ranked = rows.slice().sort((a, b) => (b.overallWinRate ?? -1) - (a.overallWinRate ?? -1));
  const models = ranked.map(r => r.model);
  const byKey = new Map(pairs.map(p => [`${p.impostorModel}|${p.crewModel}`, p]));

  const cols = models.length + 1;
  const html = [];
  html.push(`<div class="heatmap" style="grid-template-columns: 130px repeat(${models.length}, 1fr);">`);
  // Header row
  html.push(`<div class="cell corner"></div>`);
  for (const m of models) html.push(`<div class="cell h" title="${escape(m)} as crew">${shortName(m)}</div>`);
  // Body rows
  for (const imp of models) {
    html.push(`<div class="cell h" title="${escape(imp)} as impostor" style="text-align:right;padding-right:8px">${shortName(imp)}</div>`);
    for (const crew of models) {
      const p = byKey.get(`${imp}|${crew}`);
      if (!p || p.games === 0) {
        html.push(`<div class="cell empty">—</div>`);
      } else {
        const rate = p.impWinRate ?? 0;
        const color = heatColor(rate);
        html.push(`<div class="cell" style="background:${color}" title="${escape(imp)} (imp) vs ${escape(crew)} (crew) — ${p.impWins}/${p.games} = ${(rate * 100).toFixed(0)}%">
          <span class="pct">${(rate * 100).toFixed(0)}%</span><span class="n">n=${p.games}</span>
        </div>`);
      }
    }
  }
  html.push(`</div>`);
  $('heatmap-wrap').innerHTML = html.join('');
}

// 0..1 → red (impostor wins) to blue (crew wins), via dim gray at 0.5
function heatColor(v) {
  const t = Math.max(0, Math.min(1, v));
  // Two-stop gradient through a neutral midpoint.
  const r = Math.round(t < 0.5 ? 60 + 0 * (t * 2)        : 60 + 195 * ((t - 0.5) * 2));
  const g = Math.round(t < 0.5 ? 90 + 30 * (t * 2)        : 120 - 60 * ((t - 0.5) * 2));
  const b = Math.round(t < 0.5 ? 160 - 100 * (t * 2)      : 60 + 50 * ((t - 0.5) * 2));
  // Reverse: low t = crew dominant (blue-ish), high t = impostor dominant (red).
  const lowR = 60,  lowG = 110, lowB = 200;   // cool blue
  const midR = 90,  midG = 90,  midB = 110;   // muted
  const highR = 220, highG = 70, highB = 100; // hot red
  let rr, gg, bb;
  if (t < 0.5) {
    const k = t * 2;
    rr = Math.round(lowR + (midR - lowR) * k);
    gg = Math.round(lowG + (midG - lowG) * k);
    bb = Math.round(lowB + (midB - lowB) * k);
  } else {
    const k = (t - 0.5) * 2;
    rr = Math.round(midR + (highR - midR) * k);
    gg = Math.round(midG + (highG - midG) * k);
    bb = Math.round(midB + (highB - midB) * k);
  }
  return `rgb(${rr},${gg},${bb})`;
}

function shortName(s) {
  // "Claude Sonnet 4.6" → "Sonnet 4.6"; "Llama 3.3 70B Instruct" → "Llama 3.3"
  return s.replace(/^(Claude|GPT|Gemini|Llama|Qwen|MiMo|Mistral|Kimi|Grok|DeepSeek)\s/, (m) => m).slice(0, 14);
}

// ----- striking moments -----------------------------------------------------
function renderMoments(m) {
  if (!m) return;
  $('moments-section').classList.remove('hidden');

  $('gaslightings').innerHTML = (m.biggestGaslightings ?? []).slice(0, 6).map(g => `
    <div class="moment-card">
      <div class="meta">
        <span class="tag ${g.ejectedRole === 'impostor' ? 'imp' : 'crew'}">${g.witnessFlips} witness flip${g.witnessFlips === 1 ? '' : 's'}</span>
        <span>ejected: <b>${escape(g.ejectedName ?? 'no one')}</b> (${g.ejectedRole ?? '—'})</span>
        <span class="dim">${g.gameId}</span>
      </div>
      ${renderTranscript(g.transcriptTail)}
    </div>`).join('') || emptyMsg();

  $('framed').innerHTML = (m.framedInnocents ?? []).slice(0, 6).map(f => `
    <div class="moment-card">
      <div class="meta">
        <span class="tag crew">${escape(f.ejectedName)} ejected</span>
        <span class="dim">${escape(f.ejectedModel ?? '?')}</span>
        <span class="dim">${f.gameId}</span>
      </div>
      ${renderTranscript(f.transcriptTail)}
    </div>`).join('') || emptyMsg();

  $('betrayals').innerHTML = (m.betrayals ?? []).slice(0, 6).map(b => `
    <div class="moment-card">
      <div class="meta">
        <span class="tag imp">${escape(b.voterModel ?? b.voterName)} → ${escape(b.targetModel ?? b.targetName)}</span>
        <span>voted out own teammate</span>
        <span class="dim">${b.gameId}</span>
      </div>
      ${renderTranscript(b.transcriptTail)}
    </div>`).join('') || emptyMsg("No betrayals yet in this batch.");

  $('survivors').innerHTML = (m.longestSurvivingImpostors ?? []).slice(0, 6).map(s => `
    <div class="moment-card">
      <div class="meta">
        <span class="tag imp">${escape(s.model)}</span>
        <span>survived <b>${s.meetingsSurvived}/${s.gameMeetingCount}</b> meetings</span>
        <span class="dim">result: ${s.result}</span>
        <span class="dim">${s.gameId}</span>
      </div>
    </div>`).join('') || emptyMsg();
}

function renderTranscript(lines) {
  if (!lines || !lines.length) return '<div class="transcript dim">(no chat recorded — pre-transcript metrics)</div>';
  return `<div class="transcript">${lines.map(l => `<div><span class="who">${escape(l.name)}:</span> ${escape(l.text)}</div>`).join('')}</div>`;
}

function emptyMsg(s = 'No data yet.') {
  return `<div class="moment-card"><div class="dim">${s}</div></div>`;
}

function escape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

load();
