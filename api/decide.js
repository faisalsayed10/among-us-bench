// Vercel serverless function — mirrors the /api/decide route in server.js.
// Forwards a chat completion to OpenRouter with optional Anthropic/Google
// prompt caching. Accepts a user-supplied key via x-openrouter-key header.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  const userKey = req.headers['x-openrouter-key'];
  const apiKey = userKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(401).json({ error: 'no OpenRouter key — set OPENROUTER_API_KEY or pass x-openrouter-key header' });
  }

  const { model, system, messages, temperature, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }

  const supportsCaching = /^(anthropic|google)\//.test(model);
  let systemBlock = null;
  if (system) {
    systemBlock = supportsCaching
      ? { role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }
      : { role: 'system', content: system };
  }
  const fullMessages = systemBlock ? [systemBlock, ...messages] : messages;

  try {
    const referer = req.headers.origin || `https://${req.headers.host || 'amongbench.vercel.app'}`;
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
        'X-Title': 'AmongBench',
      },
      body: JSON.stringify({
        model,
        messages: fullMessages,
        temperature: temperature ?? 0.8,
        max_tokens: max_tokens ?? 600,
        response_format: { type: 'json_object' },
        usage: { include: true },
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('[openrouter]', r.status, text.slice(0, 400));
      return res.status(r.status).json({ error: text });
    }
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(text);
  } catch (err) {
    console.error('[proxy error]', err);
    return res.status(500).json({ error: String(err) });
  }
}
