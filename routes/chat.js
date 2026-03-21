const express = require('express');
const router = express.Router();

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_KEY = process.env.GROQ_API_KEY;

router.post('/', async (req, res) => {
  try {
    const { messages, temperature = 0.7, max_tokens = 1024 } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature,
        max_tokens
      })
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err.error?.message || 'Groq API error' });
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
