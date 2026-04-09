const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const { LIMITS } = require('../middleware/usage');

// Verify token and return user profile
router.post('/verify', requireAuth, async (req, res) => {
  try {
    res.json({
      ok: true,
      user: {
        id: req.user._id,
        email: req.user.email,
        name: req.user.name,
        role: req.user.role,
        plan: req.user.plan,
        emailVerified: req.user.emailVerified
      }
    });
  } catch (err) {
    console.error('Auth verify error:', err);
    res.status(500).json({ error: 'Failed to verify' });
  }
});

// Get current user profile (full)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const plan = req.user.plan || 'free';
    const limits = LIMITS[plan] || LIMITS.free;
    res.json({
      user: {
        id: req.user._id,
        email: req.user.email,
        name: req.user.name,
        phone: req.user.phone || '',
        location: req.user.location || '',
        bio: req.user.bio || '',
        role: req.user.role,
        plan,
        companyName: req.user.companyName || '',
        companyWebsite: req.user.companyWebsite || '',
        preferredRole: req.user.preferredRole || '',
        preferredLocation: req.user.preferredLocation || '',
        dailySearches: req.user.dailySearches,
        dailyApplications: req.user.dailyApplications,
        emailVerified: req.user.emailVerified,
        createdAt: req.user.createdAt,
        limits: {
          searches: limits.searches,
          applications: limits.applications
        }
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Set user role (job_seeker or employer)
router.put('/role', requireAuth, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['job_seeker', 'employer'].includes(role)) {
      return res.status(400).json({ error: 'Role must be job_seeker or employer' });
    }

    req.user.role = role;
    try {
      await req.user.save();
    } catch (saveErr) {
      console.warn('Role save to DB failed:', saveErr.message, '— role accepted in session');
    }
    res.json({ ok: true, role });
  } catch (err) {
    console.error('Set role error:', err);
    res.status(500).json({ error: 'Failed to set role' });
  }
});

// Update user profile (full)
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const allowed = ['name', 'phone', 'location', 'bio', 'companyName', 'companyWebsite', 'preferredRole', 'preferredLocation'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined && typeof req.body[key] === 'string') {
        const val = req.body[key].trim();
        if (val.length <= 500) {
          updates[key] = val;
        }
      }
    }
    Object.assign(req.user, updates);
    await req.user.save();
    res.json({ ok: true, user: updates });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Refresh user data from DB (syncs plan, role, and limits after admin changes)
router.get('/refresh', requireAuth, async (req, res) => {
  try {
    const freshUser = await User.findOne({ firebaseUid: req.firebaseUid });
    if (!freshUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update in-memory user object
    req.user = freshUser;

    const plan = freshUser.plan || 'free';
    const limits = LIMITS[plan] || LIMITS.free;

    res.json({
      ok: true,
      user: {
        id: freshUser._id,
        email: freshUser.email,
        name: freshUser.name,
        phone: freshUser.phone || '',
        location: freshUser.location || '',
        bio: freshUser.bio || '',
        role: freshUser.role,
        plan,
        dailySearches: freshUser.dailySearches,
        dailyApplications: freshUser.dailyApplications,
        emailVerified: freshUser.emailVerified,
        limits: {
          searches: limits.searches,
          applications: limits.applications
        }
      }
    });
  } catch (err) {
    console.error('Refresh user error:', err);
    res.status(500).json({ error: 'Failed to refresh user data' });
  }
});

// Delete account permanently
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const uid = req.firebaseUid;

    // Delete user from MongoDB
    await User.deleteOne({ firebaseUid: uid });

    // Delete all job posts by this employer
    const JobPost = require('../models/JobPost');
    await JobPost.deleteMany({ employerId: uid });

    // Delete from Firebase Auth
    try {
      await admin.auth().deleteUser(uid);
    } catch (fbErr) {
      console.warn('Firebase user delete failed (may not exist):', fbErr.message);
    }

    console.log(`Account deleted: ${uid}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ─── GOOGLE OAUTH ──────────────────────────────────────
const OAuthState = require('../models/OAuthState');
const crypto = require('crypto');

// Generate OAuth init URL
router.get('/google/init', async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Google OAuth not configured' });
    }

    const state = crypto.randomBytes(32).toString('hex');
    
    // Save state temporarily (2-minute TTL via schema)
    await OAuthState.create({ state });

    // Build Google OAuth URL
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: `${process.env.CORS_ORIGIN || 'http://localhost:3000'}/api/auth/google`,
      response_type: 'code',
      scope: 'openid email profile',
      state: state,
      access_type: 'offline',
      prompt: 'consent'
    });

    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
    
    res.json({ url: authUrl, state });
  } catch (err) {
    console.error('OAuth init error:', err);
    res.status(500).json({ error: 'Failed to initialize OAuth' });
  }
});

// Google OAuth callback handler
router.get('/google', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    if (!code || !state) {
      return res.status(400).json({ error: 'Missing code or state' });
    }

    // Verify state
    const oauthState = await OAuthState.findOne({ state });
    if (!oauthState) {
      return res.status(400).json({ error: 'Invalid or expired state' });
    }

    // Exchange code for token with Google
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${process.env.CORS_ORIGIN || 'http://localhost:3000'}/api/auth/google`
      })
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.json();
      console.error('Google token exchange failed:', {status: tokenRes.status, error: err});
      console.error('Attempted with:', {
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: `${process.env.CORS_ORIGIN || 'http://localhost:3000'}/api/auth/google`
      });
      return res.status(400).json({ error: 'Token exchange failed', details: err });
    }

    const tokens = await tokenRes.json();
    const idToken = tokens.id_token;

    // Verify ID token with Google
    const verifyRes = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + idToken);
    const tokenInfo = await verifyRes.json();

    if (!verifyRes.ok || tokenInfo.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(400).json({ error: 'Token verification failed' });
    }

    const { sub: googleId, email, name, picture } = tokenInfo;

    // Find or create user
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        firebaseUid: googleId,
        email,
        name: name || email.split('@')[0],
        role: ''
      });
    } else {
      // Update firebaseUid if missing
      if (!user.firebaseUid) {
        user.firebaseUid = googleId;
        await user.save();
      }
    }

    // Create or update Firebase user with email
    try {
      await admin.auth().getUser(googleId);
      // User exists, update email if needed
      await admin.auth().updateUser(googleId, {
        email: email,
        displayName: name || email.split('@')[0]
      });
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        // Create new Firebase user
        await admin.auth().createUser({
          uid: googleId,
          email: email,
          displayName: name || email.split('@')[0]
        });
      } else {
        console.error('Firebase user error:', err);
      }
    }

    // Create Firebase custom token
    const customToken = await admin.auth().createCustomToken(googleId);

    // Return HTML that postMessages to opener
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Google Sign-in</title></head>
      <body>
        <script>
          (function() {
            const token = '${customToken}';
            window.opener.postMessage({ token: token }, '${process.env.CORS_ORIGIN || 'http://localhost:3000'}');
            window.close();
          })();
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <body style="font-family: sans-serif; text-align: center; padding: 40px;">
        <h2>Sign-in Failed</h2>
        <p>${err.message}</p>
        <button onclick="window.close()">Close</button>
      </body>
      </html>
    `);
  }
});

// Send verification email (server-side)
router.post('/send-verification-email', requireAuth, async (req, res) => {
  try {
    const email = req.user.email;

    if (!email) {
      return res.status(400).json({ error: 'User email not found' });
    }

    // Check SMTP is configured
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(500).json({ error: 'Email service not configured' });
    }

    // Generate verification link using Firebase Admin SDK
    const actionCodeSettings = {
      url: `${process.env.CORS_ORIGIN || 'http://localhost:3000'}/?emailVerified=true`,
      handleCodeInApp: true
    };

    const link = await admin.auth().generateEmailVerificationLink(email, actionCodeSettings);
    console.log('Verification link generated for', email);

    // Create Nodemailer transporter
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    // Send verification email
    await transporter.sendMail({
      to: email,
      from: `${process.env.SMTP_FROM_NAME || 'Dolk Agent'} <${process.env.SMTP_USER}>`,
      subject: 'Verify your email - Dolk Agent',
      html: `
        <h2>Welcome to Dolk Agent!</h2>
        <p>Click the link below to verify your email address:</p>
        <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#6366f1;color:white;text-decoration:none;border-radius:5px;">Verify Email</a></p>
        <p>Or copy and paste this link in your browser:</p>
        <p><code>${link}</code></p>
        <p>This link expires in 24 hours.</p>
      `
    });

    console.log('Verification email sent to', email);
    res.json({ ok: true, message: 'Verification email sent' });
  } catch (err) {
    console.error('Send verification email error:', err);
    res.status(500).json({ error: 'Failed to send verification email: ' + err.message });
  }
});

module.exports = router;
