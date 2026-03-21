const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const Session = require('../models/Session');
const Application = require('../models/Application');

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
router.post('/send-email', emailLimiter, async (req, res) => {
  try {
    const { sessionId, emailTo, subject, body, jobTitle, company, location, jobUrl, matchScore, attachCV } = req.body;

    if (!sessionId || !emailTo || !subject || !body || !jobTitle || !company) {
      return res.status(400).json({ error: 'Missing required fields: sessionId, emailTo, subject, body, jobTitle, company' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailTo)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (subject.length > 200) return res.status(400).json({ error: 'Subject too long (max 200 chars)' });
    if (body.length > 10000) return res.status(400).json({ error: 'Email body too long (max 10000 chars)' });

    const transporter = createTransporter();
    if (!transporter) {
      return res.status(503).json({ error: 'Email not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASS to .env' });
    }

    const fromName = process.env.SMTP_FROM_NAME || 'Dolk Agent';
    const fromEmail = process.env.SMTP_USER;

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: emailTo,
      subject,
      text: body,
      replyTo: fromEmail
    };

    let didAttachCV = false;
    if (attachCV) {
      const session = await Session.findOne({ sessionId });
      if (session && session.cvFile && session.cvFile.length > 0) {
        mailOptions.attachments = [{
          filename: session.cvName || 'CV.pdf',
          content: session.cvFile,
          contentType: session.cvMimeType || 'application/pdf'
        }];
        didAttachCV = true;
      }
    }

    await transporter.sendMail(mailOptions);

    const followUpDate = new Date();
    followUpDate.setDate(followUpDate.getDate() + 7);

    const application = await Application.create({
      sessionId,
      jobTitle,
      company,
      location: location || '',
      emailTo,
      subject,
      body,
      cvAttached: didAttachCV,
      status: 'sent',
      jobUrl: jobUrl || '',
      matchScore: matchScore || 0,
      followUpDate
    });

    console.log(`Email sent: "${subject}" → ${emailTo} (app ID: ${application._id})`);
    res.json({ ok: true, applicationId: application._id, followUpDate });
  } catch (err) {
    console.error('Send email error:', err);
    if (err.code === 'EAUTH') {
      return res.status(401).json({ error: 'SMTP authentication failed. Check SMTP_USER and SMTP_PASS in .env' });
    }
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// Send follow-up email
router.post('/send-followup', emailLimiter, async (req, res) => {
  try {
    const { applicationId, subject, body } = req.body;
    if (!applicationId || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: applicationId, subject, body' });
    }
    if (subject.length > 200) return res.status(400).json({ error: 'Subject too long' });
    if (body.length > 10000) return res.status(400).json({ error: 'Body too long' });

    const application = await Application.findById(applicationId);
    if (!application) return res.status(404).json({ error: 'Application not found' });

    const transporter = createTransporter();
    if (!transporter) {
      return res.status(503).json({ error: 'Email not configured. Add SMTP settings to .env' });
    }

    const fromName = process.env.SMTP_FROM_NAME || 'Dolk Agent';
    const fromEmail = process.env.SMTP_USER;

    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: application.emailTo,
      subject,
      text: body,
      replyTo: fromEmail
    });

    application.status = 'followed_up';
    application.followedUpAt = new Date();
    await application.save();

    console.log(`Follow-up sent: "${subject}" → ${application.emailTo}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Follow-up error:', err);
    res.status(500).json({ error: 'Failed to send follow-up' });
  }
});

// Check email config status
router.get('/email-status', (req, res) => {
  const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  res.json({
    configured,
    host: configured ? process.env.SMTP_HOST : null,
    user: configured ? process.env.SMTP_USER.replace(/(.{2}).*(@.*)/, '$1***$2') : null
  });
});

module.exports = router;
