// ========================
// LLM PROXY SERVER
// ========================
// Holds the OpenRouter API key out of the browser bundle. The frontend hits
// /api/decide (proxied through Vite during dev) and we forward to OpenRouter.
// Model slug travels in the request body so the same harness works for any
// model — change `model` in the brain config without restarting the server.

import express from 'express';
import 'dotenv/config';

const app = express();
app.use(express.json({ limit: '2mb' }));

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'anthropic/claude-sonnet-4';

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

  const fullMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

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
        model: model || DEFAULT_MODEL,
        messages: fullMessages,
        temperature: temperature ?? 0.8,
        max_tokens: max_tokens ?? 600,
        response_format: { type: 'json_object' },
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('[openrouter]', r.status, text.slice(0, 400));
      return res.status(r.status).json({ error: text });
    }
    res.type('application/json').send(text);
  } catch (err) {
    console.error('[proxy error]', err);
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  const hasKey = !!process.env.OPENROUTER_API_KEY;
  console.log(`[llm-proxy] listening on http://localhost:${PORT}  (key: ${hasKey ? 'set' : 'MISSING'})`);
});
