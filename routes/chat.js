const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { fetch } = require('undici');
const { requireAuth } = require('../middleware/auth');
const Session = require('../models/Session');

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

    const { message, sessionId, history = [] } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message string required' });
    }

    // 1. Fetch Session from MongoDB
    let session = null;
    if (sessionId) {
      try {
        session = await Session.findById(sessionId);
      } catch (err) {
        console.warn('Session fetch error:', err.message);
      }
    }

    // 2. Safely construct the System Prompt
    let systemPrompt = "You are Dolk Agent, an expert AI job search assistant for Rwanda and East Africa.";

    if (session && session.cvText) {
      // CRITICAL: Clean the text of null bytes and weird characters
      let cleanCvText = session.cvText.replace(/\0/g, '').trim();

      // CRITICAL: Truncate to ~10,000 characters to prevent Groq API crashes
      if (cleanCvText.length > 10000) {
        cleanCvText = cleanCvText.substring(0, 10000) + "... [CV Truncated]";
      }

      systemPrompt += `\n\nHere is the user's uploaded CV context to help them:\n${cleanCvText}`;
    }

    // 3. Prepare the exact payload Groq expects
    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message }
    ];

    // Validate messages
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        return res.status(400).json({ error: 'Each message must be an object' });
      }
      if (!['system', 'user', 'assistant'].includes(msg.role)) {
        return res.status(400).json({ error: 'Invalid message role' });
      }
      if (typeof msg.content !== 'string' || msg.content.length > 15000) {
        return res.status(400).json({ error: 'Message content must be string (max 15000 chars)' });
      }
    }

    // 4. Call Groq API
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg = err.error?.message || 'AI service temporarily unavailable';
      console.error("Chat Endpoint Error - Groq API Error Detail:", r.status, msg);
      return res.status(502).json({ error: msg });
    }

    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    res.json({ reply: text.trim() });

  } catch (error) {
    console.error("Chat Endpoint Error:", error);
    res.status(500).json({ error: "Agent is currently having trouble processing that request." });
  }
});

module.exports = router;
