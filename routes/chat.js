const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { fetch } = require('undici');
const { requireAuth } = require('../middleware/auth');

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many chat requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false
});

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_KEY = process.env.GROQ_API_KEY;

router.post('/', chatLimiter, requireAuth, async (req, res) => {
  try {
    if (!GROQ_KEY) {
      return res.status(503).json({ error: 'AI chat is not configured. Set GROQ_API_KEY in your .env file.' });
    }

    const { messages, temperature = 0.7, max_tokens = 1024 } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }
    if (messages.length === 0 || messages.length > 50) {
      return res.status(400).json({ error: 'messages must have 1-50 entries' });
    }

    // Validate each message has a role and content string
    const validRoles = ['system', 'user', 'assistant'];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        return res.status(400).json({ error: 'Each message must be an object' });
      }
      if (!validRoles.includes(msg.role)) {
        return res.status(400).json({ error: 'Each message must have a valid role (system, user, assistant)' });
      }
      if (typeof msg.content !== 'string' || msg.content.length > 15000) {
        return res.status(400).json({ error: 'Each message content must be a string (max 15000 chars)' });
      }
    }

    // Clamp temperature and max_tokens to safe ranges
    const safeTemp = Math.min(Math.max(Number(temperature) || 0.7, 0), 2);
    const safeMaxTokens = Math.min(Math.max(Math.floor(Number(max_tokens) || 1024), 1), 4096);

    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: safeTemp,
        max_tokens: safeMaxTokens
      })
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg = err.error?.message || 'AI service temporarily unavailable';
      console.error('Groq API error:', r.status, msg);
      // Don't forward Groq's status codes — normalize to 502 (bad gateway) so frontend can distinguish
      return res.status(502).json({ error: msg });
    }

    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    res.json({ text: text.trim() });
  } catch (err) {
    console.error('Groq proxy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
