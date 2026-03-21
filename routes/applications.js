const express = require('express');
const router = express.Router();
const Application = require('../models/Application');

// List applications for a session
router.get('/:sessionId', async (req, res) => {
  try {
    const apps = await Application.find({ sessionId: req.params.sessionId }).sort({ sentAt: -1 });
    res.json({ applications: apps });
  } catch (err) {
    console.error('List applications error:', err);
    res.status(500).json({ error: 'Failed to load applications' });
  }
});

// Update application status
router.put('/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const validStatuses = ['sent', 'followed_up', 'replied', 'rejected', 'offered'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: ' + validStatuses.join(', ') });
    }

    const update = {};
    if (status) update.status = status;
    if (status === 'followed_up') update.followedUpAt = new Date();
    if (notes !== undefined) update.notes = notes;

    const app = await Application.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!app) return res.status(404).json({ error: 'Application not found' });
    res.json({ ok: true, application: app });
  } catch (err) {
    console.error('Update application error:', err);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

// Get follow-up reminders
router.get('/follow-ups/:sessionId', async (req, res) => {
  try {
    const now = new Date();
    const apps = await Application.find({
      sessionId: req.params.sessionId,
      status: 'sent',
      followUpDate: { $lte: now }
    }).sort({ followUpDate: 1 });
    res.json({ reminders: apps });
  } catch (err) {
    console.error('Follow-ups error:', err);
    res.status(500).json({ error: 'Failed to load follow-ups' });
  }
});

module.exports = router;
