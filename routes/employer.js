const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const JobPost = require('../models/JobPost');

const employerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false
});
router.use(employerLimiter);

// Escape regex special characters to prevent ReDoS
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Post a new job (employer only)
router.post('/post-job', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'employer') {
      return res.status(403).json({ error: 'Only employers can post jobs. Your current role is: ' + (req.user.role || 'not set') + '. Please switch to Employer mode first.' });
    }

    const { title, company, location, type, description, requirements, salary_min, salary_max, salary_currency, contactEmail, deadline, is_remote, categories, tags } = req.body;

    if (!title || !company || !location || !description || !contactEmail) {
      return res.status(400).json({ error: 'Missing required fields: title, company, location, description, contactEmail' });
    }
    if (title.length > 200) return res.status(400).json({ error: 'Title too long (max 200)' });
    if (description.length > 5000) return res.status(400).json({ error: 'Description too long (max 5000)' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(contactEmail)) {
      return res.status(400).json({ error: 'Invalid contact email' });
    }
    if (company.length > 200) return res.status(400).json({ error: 'Company name too long (max 200)' });
    if (location.length > 200) return res.status(400).json({ error: 'Location too long (max 200)' });
    if (requirements && typeof requirements === 'string' && requirements.length > 3000) {
      return res.status(400).json({ error: 'Requirements too long (max 3000)' });
    }
    if (salary_min !== undefined && salary_min !== null && (typeof salary_min !== 'number' || salary_min < 0 || salary_min > 100000000)) {
      return res.status(400).json({ error: 'Invalid salary_min (0 - 100,000,000)' });
    }
    if (salary_max !== undefined && salary_max !== null && (typeof salary_max !== 'number' || salary_max < 0 || salary_max > 100000000)) {
      return res.status(400).json({ error: 'Invalid salary_max (0 - 100,000,000)' });
    }
    if (deadline && isNaN(new Date(deadline).getTime())) {
      return res.status(400).json({ error: 'Invalid deadline date' });
    }

    const job = await JobPost.create({
      employerId: req.firebaseUid,
      employerEmail: req.user.email,
      title: title.trim(),
      company: company.trim(),
      location: location.trim(),
      type: type || 'Full-time',
      description: description.trim(),
      requirements: (requirements || '').trim(),
      salary_min: salary_min || null,
      salary_max: salary_max || null,
      salary_currency: salary_currency || 'USD',
      contactEmail: contactEmail.trim(),
      deadline: deadline ? new Date(deadline) : null,
      is_remote: !!is_remote,
      categories: Array.isArray(categories) ? categories.map(c => String(c).trim()).filter(Boolean).slice(0, 5) : [],
      tags: Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean).slice(0, 10) : []
    });

    console.log(`Job posted: "${title}" at "${company}" by ${req.user.email}`);
    res.json({ ok: true, job });
  } catch (err) {
    console.error('Post job error:', err);
    if (err.name === 'MongooseError' || err.message?.includes('buffering timed out') || err.message?.includes('Could not connect')) {
      return res.status(503).json({ error: 'Database is temporarily unavailable. Your job posting could not be saved. Please try again in a moment.' });
    }
    res.status(500).json({ error: 'Failed to post job' });
  }
});

// Get employer's own listings
router.get('/my-jobs', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'employer') {
      return res.status(403).json({ error: 'Only employers can view their listings' });
    }
    const jobs = await JobPost.find({ employerId: req.firebaseUid }).sort({ createdAt: -1 });
    res.json({ jobs });
  } catch (err) {
    console.error('My jobs error:', err);
    if (err.name === 'MongooseError' || err.message?.includes('buffering timed out') || err.message?.includes('Could not connect')) {
      return res.json({ jobs: [], dbUnavailable: true });
    }
    res.status(500).json({ error: 'Failed to load jobs' });
  }
});

// Edit a job listing
router.put('/jobs/:id', requireAuth, async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.employerId !== req.firebaseUid) {
      return res.status(403).json({ error: 'You can only edit your own listings' });
    }

    const allowed = ['title', 'company', 'location', 'type', 'description', 'requirements', 'salary_min', 'salary_max', 'salary_currency', 'contactEmail', 'deadline', 'status', 'is_remote', 'categories', 'tags'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) job[key] = req.body[key];
    }
    await job.save();
    res.json({ ok: true, job });
  } catch (err) {
    console.error('Edit job error:', err);
    res.status(500).json({ error: 'Failed to edit job' });
  }
});

// Delete a job listing
router.delete('/jobs/:id', requireAuth, async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.employerId !== req.firebaseUid) {
      return res.status(403).json({ error: 'You can only delete your own listings' });
    }
    await job.deleteOne();
    console.log(`Job deleted: "${job.title}" by ${req.user.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete job error:', err);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// Search local (employer-posted) jobs — public endpoint (rate-limited)
const publicSearchLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many requests. Please wait.' } });
router.get('/local-jobs', publicSearchLimiter, async (req, res) => {
  try {
    const { query, location } = req.query;
    if (query && (typeof query !== 'string' || query.length > 200)) return res.status(400).json({ error: 'Query too long (max 200 chars)' });
    if (location && (typeof location !== 'string' || location.length > 100)) return res.status(400).json({ error: 'Location too long (max 100 chars)' });
    const filter = { status: 'active' };

    // Check deadline hasn't passed
    filter.$or = [
      { deadline: null },
      { deadline: { $gte: new Date() } }
    ];

    if (query) {
      filter.$text = { $search: query };
    }
    if (location) {
      filter.location = { $regex: escapeRegex(location), $options: 'i' };
    }

    const jobs = await JobPost.find(filter).sort({ createdAt: -1 }).limit(20);

    const formatted = jobs.map(j => ({
      title: j.title,
      company: j.company,
      location: j.location,
      type: j.type,
      is_remote: j.is_remote,
      url: null,
      description: j.description,
      highlights: [],
      posted: j.createdAt,
      salary_min: j.salary_min,
      salary_max: j.salary_max,
      salary_currency: j.salary_currency,
      salary_period: j.salary_min ? 'year' : null,
      employer_logo: null,
      source: 'local',
      hiring_email: j.contactEmail,
      categories: j.categories || [],
      tags: j.tags || [],
      match: 0,
      why: ''
    }));

    res.json({ jobs: formatted, total: formatted.length });
  } catch (err) {
    console.error('Local jobs error:', err);
    res.status(500).json({ error: 'Failed to search local jobs' });
  }
});

module.exports = router;
