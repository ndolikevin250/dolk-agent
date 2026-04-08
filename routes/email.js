const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const { getCVForUser } = require('./cv');
const { requireAuth } = require('../middleware/auth');
const { checkApplicationLimit, incrementApplications } = require('../middleware/usage');
const stats = require('../lib/stats');

const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many emails sent. Please wait before sending more.' },
  standardHeaders: true,
  legacyHeaders: false
});

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

// Send application email
router.post('/send-email', emailLimiter, requireAuth, checkApplicationLimit, async (req, res) => {
  try {
    if (!req.user.emailVerified) {
      return res.status(403).json({ error: 'Please verify your email address before sending applications. Check your inbox for a verification link.' });
    }

    const { emailTo, subject, body, jobTitle, company, location, jobUrl, matchScore, attachCV } = req.body;

    if (!emailTo || !subject || !body || !jobTitle || !company) {
      return res.status(400).json({ error: 'Missing required fields: emailTo, subject, body, jobTitle, company' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailTo)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (typeof subject !== 'string' || subject.length > 200) return res.status(400).json({ error: 'Subject too long (max 200 chars)' });
    if (typeof body !== 'string' || body.length > 10000) return res.status(400).json({ error: 'Email body too long (max 10000 chars)' });
    if (typeof jobTitle !== 'string' || jobTitle.length > 200) return res.status(400).json({ error: 'Job title too long (max 200 chars)' });
    if (typeof company !== 'string' || company.length > 200) return res.status(400).json({ error: 'Company name too long (max 200 chars)' });
    if (location && (typeof location !== 'string' || location.length > 200)) return res.status(400).json({ error: 'Location too long (max 200 chars)' });
    if (jobUrl && (typeof jobUrl !== 'string' || jobUrl.length > 2000)) return res.status(400).json({ error: 'Job URL too long (max 2000 chars)' });

    const transporter = createTransporter();
    if (!transporter) {
      return res.status(503).json({ error: 'Email not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASS to .env' });
    }

    const fromName = process.env.SMTP_FROM_NAME || 'Dolk Agent';
    const fromEmail = process.env.SMTP_USER;

    const applicantEmail = req.user.email || fromEmail;
    const applicantName = req.user.name || '';
    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: emailTo,
      subject,
      text: body,
      replyTo: applicantName ? `"${applicantName}" <${applicantEmail}>` : applicantEmail
    };

    let didAttachCV = false;
    if (attachCV) {
      const cvData = await getCVForUser(req.firebaseUid);
      if (cvData && cvData.buffer && cvData.buffer.length > 0) {
        mailOptions.attachments = [{
          filename: cvData.name || 'CV.pdf',
          content: cvData.buffer,
          contentType: cvData.mimeType || 'application/pdf'
        }];
        didAttachCV = true;
      }
    }

    await transporter.sendMail(mailOptions);

    const followUpDate = new Date();
    followUpDate.setDate(followUpDate.getDate() + 7);

    // Increment daily application counter (persisted on User model)
    if (req.user) await incrementApplications(req.user);

    // Increment in-memory stat counter
    stats.totalApplicationsSent++;

    console.log(`Email sent: "${subject}" -> ${emailTo} (CV attached: ${didAttachCV})`);
    res.json({ ok: true, followUpDate, cvAttached: didAttachCV });
  } catch (err) {
    console.error('Send email error:', err);
    if (err.code === 'EAUTH') {
      return res.status(401).json({ error: 'SMTP authentication failed. Check SMTP_USER and SMTP_PASS in .env' });
    }
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// Send follow-up email (accepts data directly — no DB lookup)
router.post('/send-followup', emailLimiter, requireAuth, async (req, res) => {
  try {
    const { emailTo, subject, body } = req.body;
    if (!emailTo || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: emailTo, subject, body' });
    }
    if (subject.length > 200) return res.status(400).json({ error: 'Subject too long' });
    if (body.length > 10000) return res.status(400).json({ error: 'Body too long' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailTo)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const transporter = createTransporter();
    if (!transporter) {
      return res.status(503).json({ error: 'Email not configured. Add SMTP settings to .env' });
    }

    const fromName = process.env.SMTP_FROM_NAME || 'Dolk Agent';
    const fromEmail = process.env.SMTP_USER;

    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: emailTo,
      subject,
      text: body,
      replyTo: fromEmail
    });

    console.log(`Follow-up sent: "${subject}" -> ${emailTo}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Follow-up error:', err);
    res.status(500).json({ error: 'Failed to send follow-up' });
  }
});

// Check email config status
router.get('/email-status', requireAuth, (req, res) => {
  const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  res.json({
    configured,
    host: configured ? process.env.SMTP_HOST : null,
    user: configured ? process.env.SMTP_USER.replace(/(.{2}).*(@.*)/, '$1***$2') : null
  });
});

module.exports = router;
