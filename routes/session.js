const express = require('express');
const router = express.Router();
const Session = require('../models/Session');

// Strip MongoDB operator keys ($ prefix) from objects to prevent injection
function sanitizeObj(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObj);
  if (typeof obj === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!k.startsWith('$')) clean[k] = sanitizeObj(v);
    }
    return clean;
  }
  return obj;
}

// Save session
router.post('/', async (req, res) => {
  try {
    const { sessionId, cvText, cvName, cvData, chatHistory, jobs, appliedJobs, userPrefs } = req.body;

    // Validate types and lengths
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }
    if (cvText && (typeof cvText !== 'string' || cvText.length > 15000)) {
      return res.status(400).json({ error: 'cvText too long (max 15000)' });
    }
    if (cvName && (typeof cvName !== 'string' || cvName.length > 200)) {
      return res.status(400).json({ error: 'cvName too long (max 200)' });
    }
    if (chatHistory && (!Array.isArray(chatHistory) || chatHistory.length > 200)) {
      return res.status(400).json({ error: 'chatHistory must be array (max 200 entries)' });
    }
    if (jobs && (!Array.isArray(jobs) || jobs.length > 50)) {
      return res.status(400).json({ error: 'jobs must be array (max 50 entries)' });
    }
    if (appliedJobs && (!Array.isArray(appliedJobs) || appliedJobs.length > 50)) {
      return res.status(400).json({ error: 'appliedJobs must be array (max 50 entries)' });
    }

    // Sanitize objects to prevent MongoDB injection
    const safeData = {
      cvText: cvText || '',
      cvName: cvName || '',
      cvData: sanitizeObj(cvData || {}),
      chatHistory: sanitizeObj(chatHistory || []),
      jobs: sanitizeObj(jobs || []),
      appliedJobs: sanitizeObj(appliedJobs || []),
      userPrefs: sanitizeObj(userPrefs || {})
    };

    await Session.findOneAndUpdate(
      { sessionId },
      safeData,
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Save session error:', err);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

// Load session
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id || typeof id !== 'string' || id.length > 64) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const session = await Session.findOne({ sessionId: id });
    if (!session) return res.json({ found: false });
    res.json({
      found: true,
      cvText: session.cvText,
      cvName: session.cvName,
      cvData: session.cvData,
      chatHistory: session.chatHistory,
      jobs: session.jobs,
      appliedJobs: session.appliedJobs,
      userPrefs: session.userPrefs
    });
  } catch (err) {
    console.error('Load session error:', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

module.exports = router;
