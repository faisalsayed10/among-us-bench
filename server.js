// ========================
// LLM PROXY SERVER
// ========================
// Holds the OpenRouter API key out of the browser bundle. The frontend hits
// /api/decide (proxied through Vite during dev) and we forward to OpenRouter.
// Model slug travels in the request body so the same harness works for any
// model — change `model` in the brain config without restarting the server.

import express from 'express';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const METRICS_PATH = path.join(__dirname, 'metrics.jsonl');

const app = express();
app.use(express.json({ limit: '2mb' }));

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasKey: !!process.env.OPENROUTER_API_KEY });
});

app.post('/api/decide', async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY not set on server' });
  }
  const { model, system, messages, temperature, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }

  // Prompt caching: the system prompt is ~1.5K tokens and identical every
  // call for a given agent. Anthropic and a handful of others on OpenRouter
  // support `cache_control: { type: "ephemeral" }` marker on a content block
  // — cached prefix reads are ~90% cheaper. For providers that don't support
  // it, the field is silently ignored. We only opt in when the provider is
  // known to honor it, to avoid the structured-content format breaking
  // simpler backends.
  const supportsCaching = /^(anthropic|google)\//.test(model);

  let systemBlock = null;
  if (system) {
    systemBlock = supportsCaching
      ? {
          role: 'system',
          content: [
            { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
          ],
        }
      : { role: 'system', content: system };
  }

  const fullMessages = systemBlock ? [systemBlock, ...messages] : messages;

  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5173',
        'X-Title': 'Among Us Simulation',
      },
      body: JSON.stringify({
        model: model,
        messages: fullMessages,
        temperature: temperature ?? 0.8,
        max_tokens: max_tokens ?? 600,
        response_format: { type: 'json_object' },
        // Ask OpenRouter to include cost (USD) in the usage block.
        usage: { include: true },
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('[openrouter]', r.status, text.slice(0, 400));
      return res.status(r.status).json({ error: text });
    }
    // Optional dev-time logging of cache hit rate. Anthropic returns
    // prompt_tokens_details.cached_tokens; many providers don't report this.
    if (process.env.LOG_CACHE) {
      try {
        const j = JSON.parse(text);
        const u = j.usage || {};
        const cached = u.prompt_tokens_details?.cached_tokens
          ?? u.cache_read_input_tokens ?? 0;
        const input = u.prompt_tokens ?? u.input_tokens ?? 0;
        if (input) {
          const pct = input > 0 ? Math.round((cached / input) * 100) : 0;
          console.log(`[cache] ${model}  in=${input}  cached=${cached}  (${pct}%)`);
        }
      } catch {}
    }
    res.type('application/json').send(text);
  } catch (err) {
    console.error('[proxy error]', err);
    res.status(500).json({ error: String(err) });
  }
});

// Append one JSON record per finished game. Cheap, human-readable, easy to
// process later with jq / pandas / whatever. No DB needed.
app.post('/api/log-metrics', async (req, res) => {
  try {
    const line = JSON.stringify(req.body || {}) + '\n';
    await appendFile(METRICS_PATH, line, 'utf8');
    res.json({ ok: true, path: METRICS_PATH });
  } catch (err) {
    console.error('[metrics] write failed', err);
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  const hasKey = !!process.env.OPENROUTER_API_KEY;
  console.log(`[llm-proxy] listening on http://localhost:${PORT}  (key: ${hasKey ? 'set' : 'MISSING'})`);
});
