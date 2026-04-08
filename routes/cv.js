const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const mammoth = require('mammoth');
const { requireAuth } = require('../middleware/auth');
const stats = require('../lib/stats');
const CV = require('../models/CV');

const cvUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15,
  message: { error: 'Too many uploads. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Upload CV file (stores in MongoDB with 24h TTL for email attachment)
router.post('/upload-cv', cvUploadLimiter, requireAuth, express.raw({ type: 'application/octet-stream', limit: '5mb' }), async (req, res) => {
  try {
    const rawFileName = req.headers['x-file-name'] || 'cv.pdf';
    const rawMimeType = req.headers['x-mime-type'] || 'application/pdf';

    // Sanitize file name and mime type
    const fileName = rawFileName.replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 100);
    const allowedMimes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'text/plain'];
    const mimeType = allowedMimes.includes(rawMimeType) ? rawMimeType : 'application/pdf';

    if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file data received' });

    // Upsert: replace existing CV for this user
    await CV.findOneAndUpdate(
      { firebaseUid: req.firebaseUid },
      {
        firebaseUid: req.firebaseUid,
        fileName,
        mimeType,
        data: Buffer.from(req.body),
        size: req.body.length,
        uploadedAt: new Date()
      },
      { upsert: true }
    );

    stats.totalCVsUploaded++;

    console.log(`CV stored: "${fileName}" (${(req.body.length / 1024).toFixed(1)}KB) for user ${req.firebaseUid.slice(0, 8)}...`);
    res.json({ ok: true, size: req.body.length });
  } catch (err) {
    console.error('CV upload error:', err);
    res.status(500).json({ error: 'Failed to store CV file' });
  }
});

// Parse DOCX file to text
router.post('/parse-docx', requireAuth, express.raw({ type: 'application/octet-stream', limit: '5mb' }), async (req, res) => {
  try {
    const result = await mammoth.extractRawText({ buffer: req.body });
    res.json({ text: result.value });
  } catch (err) {
    console.error('DOCX parse error:', err);
    res.status(500).json({ error: 'Failed to parse DOCX file' });
  }
});

// Helper: get CV data for email attachment
async function getCVForUser(firebaseUid) {
  const cv = await CV.findOne({ firebaseUid });
  if (!cv) return null;
  return { buffer: cv.data, name: cv.fileName, mimeType: cv.mimeType };
}

module.exports = router;
module.exports.getCVForUser = getCVForUser;
