const express = require('express');
const router = express.Router();
const mammoth = require('mammoth');
const Session = require('../models/Session');

// Upload CV file (stores original binary for email attachment)
router.post('/upload-cv', express.raw({ type: 'application/octet-stream', limit: '5mb' }), async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const fileName = req.headers['x-file-name'] || 'cv.pdf';
    const mimeType = req.headers['x-mime-type'] || 'application/pdf';

    if (!sessionId) return res.status(400).json({ error: 'x-session-id header required' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file data received' });

    await Session.findOneAndUpdate(
      { sessionId },
      { cvFile: req.body, cvMimeType: mimeType, cvName: fileName },
      { upsert: true }
    );

    console.log(`CV stored: "${fileName}" (${(req.body.length / 1024).toFixed(1)}KB) for session ${sessionId.slice(0, 12)}…`);
    res.json({ ok: true, size: req.body.length });
  } catch (err) {
    console.error('CV upload error:', err);
    res.status(500).json({ error: 'Failed to store CV file' });
  }
});

// Parse DOCX file to text
router.post('/parse-docx', express.raw({ type: 'application/octet-stream', limit: '5mb' }), async (req, res) => {
  try {
    const result = await mammoth.extractRawText({ buffer: req.body });
    res.json({ text: result.value });
  } catch (err) {
    console.error('DOCX parse error:', err);
    res.status(500).json({ error: 'Failed to parse DOCX file' });
  }
});

module.exports = router;
