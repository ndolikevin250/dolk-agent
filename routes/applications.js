const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const Application = require('../models/Application');
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false
});

router.use(limiter);

// Record a sent application
router.post('/', requireAuth, async (req, res) => {
  try {
    const { jobId, jobTitle, company, jobSource, appliedJobUrl, coverLetterText } = req.body;

    if (!jobId || !jobTitle || !company) {
      return res.status(400).json({ error: 'Missing required fields: jobId, jobTitle, company' });
    }

    // Check if already applied (de-duplication)
    const existing = await Application.findOne({
      firebaseUid: req.firebaseUid,
      jobId
    });

    if (existing) {
      return res.status(409).json({ error: 'Already applied to this job', applicationId: existing._id });
    }

    const app = await Application.create({
      firebaseUid: req.firebaseUid,
      jobId,
      jobTitle,
      company,
      jobSource: jobSource || 'jsearch',
      appliedJobUrl,
      coverLetterText,
      status: 'sent',
      emailSentAt: new Date(),
      nextFollowUpAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    });

    res.json({ ok: true, applicationId: app._id, nextFollowUpAt: app.nextFollowUpAt });
  } catch (err) {
    console.error('Create application error:', err);
    res.status(500).json({ error: 'Failed to record application' });
  }
});

// Get user's applications (paginated)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { firebaseUid: req.firebaseUid };
    if (status) filter.status = status;

    const [applications, total] = await Promise.all([
      Application.find(filter)
        .sort({ appliedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Application.countDocuments(filter)
    ]);

    res.json({
      applications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Get applications error:', err);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// Get applications due for follow-up
router.get('/followup/due', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const apps = await Application.find({
      firebaseUid: req.firebaseUid,
      nextFollowUpAt: { $lte: now },
      status: { $in: ['sent', 'interview'] },
      followUpCount: { $lt: 3 } // Max 3 follow-ups
    }).sort({ nextFollowUpAt: 1 });

    res.json({ applications: apps });
  } catch (err) {
    console.error('Get follow-up applications error:', err);
    res.status(500).json({ error: 'Failed to fetch follow-up applications' });
  }
});

// Update application status and schedule next follow-up
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { status, notes, feedback, scheduleNextFollowUp } = req.body;

    const app = await Application.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.firebaseUid !== req.firebaseUid) {
      return res.status(403).json({ error: 'Cannot update another user\'s application' });
    }

    if (status) app.status = status;
    if (notes) app.notes = notes;
    if (feedback) app.feedback = feedback;

    if (scheduleNextFollowUp) {
      const days = scheduleNextFollowUp === 'week' ? 7 : scheduleNextFollowUp === 'month' ? 30 : 7;
      app.nextFollowUpAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      app.followUpCount = (app.followUpCount || 0) + 1;
      app.lastFollowUpAt = new Date();
    }

    await app.save();
    res.json({ ok: true, application: app });
  } catch (err) {
    console.error('Update application error:', err);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

// Delete application
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const app = await Application.findById(req.params.id);
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.firebaseUid !== req.firebaseUid) {
      return res.status(403).json({ error: 'Cannot delete another user\'s application' });
    }

    await app.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete application error:', err);
    res.status(500).json({ error: 'Failed to delete application' });
  }
});

// Get applications to remind (due within 3 days)
router.get('/reminders/upcoming', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const apps = await Application.find({
      firebaseUid: req.firebaseUid,
      nextFollowUpAt: { $gt: now, $lte: in3Days },
      status: { $in: ['sent', 'interview'] }
    }).sort({ nextFollowUpAt: 1 });

    res.json({ reminders: apps });
  } catch (err) {
    console.error('Get reminders error:', err);
    res.status(500).json({ error: 'Failed to fetch reminders' });
  }
});

module.exports = router;
