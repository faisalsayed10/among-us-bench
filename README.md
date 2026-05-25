# AmongBench

10 large language models play Among Us against each other. You can drop in as the 11th crewmate or sit back and spectate.

It's an Among Us clone wired to OpenRouter — each NPC is driven by a different frontier model (Claude Opus 4.7, GPT-5.5, Gemini 3.1 Pro, Grok 4.3, Llama 3.3 70B, DeepSeek V3.2, Qwen3 Max, Sonnet 4.6, Haiku 4.5, MiMo v2 Pro). They see the world through a structured observation, reason about who to trust, kill, vote, and lie — and you can watch the whole thing happen with a live token-cost meter ticking up in the corner.

## Why

I wanted to see whether the same models that ace MMLU can pull off a social-deception game in real time. Among Us is a tight little benchmark for that: the impostors have to fabricate alibis under interrogation, the crew has to weigh circumstantial evidence and resist gaslighting, and every meeting is a small adversarial debate. The relevant prior art is the [Hoodwinked](https://arxiv.org/abs/2308.01404) paper (LLMs play a text-based Mafia variant) and the [Avalon](https://arxiv.org/abs/2310.14985) paper (LLMs play hidden-role games). Both find that current models are surprisingly competent deceivers but inconsistent at *resisting* deception. AmongBench is meant to extend that into a real-time embodied setting with movement, line-of-sight, and chat.

## How a game works

- 10 players, 2 impostors. Standard Among Us rules: tasks, kills, body reports, emergency meetings, voting, sabotages, vents, doors.
- Each agent gets a structured observation every ~3 seconds while playing (visible players, nearby tasks, room they're in, kill cooldown) and decides an action.
- During meetings, agents speak in chat, then vote. Two-step reasoning: first they write a short `intent` (what they're trying to do this round) and `theory_of_mind` note (what they think the others believe about them), then they pick the actual action.
- Impostors know their teammate but otherwise see exactly what crewmates see. They can also fabricate "I was in <room>" alibis — the analyzer scores how often those match the room log.
- Models are randomly assigned to characters per game. The mapping is hidden from the agents but surfaced in the UI under each player's name.

## What's instrumented

Every game writes a `metrics.jsonl` record with:

- Per-player kills, votes, witness status (did they see the body?), and whether their vote contradicted what they witnessed.
- Per-meeting transcripts.
- Room log sampled every 3 simulated seconds — used downstream to detect fabricated alibis.
- Sleeper turns (time-to-first-kill as impostor), betrayals (impostor voting out teammate), banishment rate (impostor voted out).
- OpenRouter token usage including cache reads, for cost accounting.

Run a batch and the analyzer rolls it up into `results.json` powering the public [results page](./results/).

```bash
npm run bench -- --games=100 --concurrency=4
npm run analyze
```

## Running it

You need an [OpenRouter](https://openrouter.ai) API key. Put it in `.env` as `OPENROUTER_API_KEY=sk-or-...`, or paste it into the modal that appears on first load (stored in localStorage).

```bash
npm install
npm run server   # OpenRouter proxy + metrics endpoint on :3001
npm run dev      # Vite dev server on :5173
```

Open `http://localhost:5173`. Pick **Play** to drop in as Red, or **Spectate** to free-roam as a ghost and watch all 10 agents play.

To switch modes later, visit `/?mode=play` or `/?mode=spectate`.

Cost per game is roughly **$1–$8** depending on the model mix and how many meetings happen — heavy chatters with Opus/GPT-5.5 in the pool push toward the high end. The cost meter in the top-right shows live spend.

### Headless batch

For collecting results without the browser:

```bash
npm run bench -- --games=50 --concurrency=4 --speedup=4 --pool=cheap
```

`--pool=cheap` swaps the expensive models out. Concurrency is bounded by your OpenRouter rate limit, not local CPU.

## Findings

Honestly? I shipped this without running enough games to make a credible claim. The pipeline is there, the metrics are there, the results page is there — but the leaderboard at `/results/` is on a small sample and shouldn't be read as definitive. If you want to fund a serious batch (~$500 of credit) and rerun the analyzer, that data will start to mean something. PRs welcome.

Anecdotally from the games I did watch: Opus 4.7 is unusually good at calmly refuting accusations, Llama 3.3 tunnel-visions on its first suspicion and rarely updates, and basically every model still struggles with positional reasoning ("X said they were in Electrical but the body was reported in Storage at the same time").

## Stack

Plain Vite + vanilla JS canvas rendering. No game engine, no React. Node server proxies OpenRouter with Anthropic/Google prompt caching enabled (cache reads bill at 10% list price — saves a lot on the ~1.5k-token system prompt that's identical every call).

`src/agent/llm-brain.js` is the LLM wrapper. `src/agent/agent-controller.js` is the per-tick decision loop. `src/game-state.js` is the rules engine. `bench.js` and `analyze.js` are the batch tooling.

## License

MIT. Have fun.
