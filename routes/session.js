const express = require('express');
const router = express.Router();
const Session = require('../models/Session');
const { requireAuth } = require('../middleware/auth');

// Save session (overwrites previous session with same sessionId)
router.post('/save', requireAuth, async (req, res) => {
  try {
    const { sessionId, cvText, cvName, cvData, chatHistory, jobResults, userPrefs, appliedJobIds } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }
    
    // Verify ownership: sessionId must start with user's UID
    if (!sessionId.includes(req.firebaseUid)) {
      return res.status(403).json({ error: 'Cannot save another user\'s session' });
    }
    
    // Upsert: update if exists, create if not
    const session = await Session.findOneAndUpdate(
      { sessionId, firebaseUid: req.firebaseUid },
      {
        $set: {
          cvText: cvText || '',
          cvName: cvName || '',
          cvData: cvData || {},
          chatHistory: chatHistory || [],
          jobResults: jobResults || [],
          userPrefs: userPrefs || {},
          appliedJobIds: appliedJobIds || [],
          updatedAt: new Date()
        }
      },
      { upsert: true, new: true }
    );
    
    res.json({ ok: true, sessionId: session.sessionId });
  } catch (err) {
    console.error('Session save error:', err);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

// Load session
router.get('/:sessionId', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Verify ownership
    if (!sessionId.includes(req.firebaseUid)) {
      return res.status(403).json({ error: 'Cannot access another user\'s session' });
    }
    
    const session = await Session.findOne({ sessionId, firebaseUid: req.firebaseUid });
    
    if (!session) {
      return res.json({ 
        ok: true, 
        session: {
          sessionId,
          cvText: '',
          cvName: '',
          cvData: {},
          chatHistory: [],
          jobResults: [],
          userPrefs: {},
          appliedJobIds: []
        }
      });
    }
    
    res.json({ ok: true, session });
  } catch (err) {
    console.error('Session load error:', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

// Delete session
router.delete('/:sessionId', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Verify ownership
    if (!sessionId.includes(req.firebaseUid)) {
      return res.status(403).json({ error: 'Cannot delete another user\'s session' });
    }
    
    await Session.deleteOne({ sessionId, firebaseUid: req.firebaseUid });
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Session delete error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Clean up old sessions (optional admin utility)
router.post('/cleanup', requireAuth, async (req, res) => {
  try {
    // Only delete sessions older than retention period
    const retentionDays = 30;
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    
    const result = await Session.deleteMany({
      firebaseUid: req.firebaseUid,
      createdAt: { $lt: cutoffDate }
    });
    
    res.json({ ok: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error('Session cleanup error:', err);
    res.status(500).json({ error: 'Failed to cleanup sessions' });
  }
});

module.exports = router;
