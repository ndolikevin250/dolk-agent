const admin = require('firebase-admin');
const User = require('../models/User');

// Firebase Admin is initialized in server.js (before OAuth routes).
// This guard is kept as a safety net in case middleware is loaded standalone.
if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccount) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(serviceAccount))
      });
      console.log('Firebase Admin initialized (middleware fallback)');
    } catch (err) {
      console.error('Firebase Admin init error:', err.message);
    }
  }
}

// Auth middleware — verifies Firebase ID token
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No auth token provided' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
    return res.status(401).json({ error: 'Malformed auth token' });
  }
  const token = parts[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUid = decoded.uid;
    req.firebaseEmail = decoded.email || '';

    // Role claimed by the frontend (trusted because Firebase token is verified)
    const claimedRole = req.headers['x-user-role'];
    const validRoles = ['job_seeker', 'employer'];

    // Attach user from DB (create if first time)
    let dbAvailable = true;
    try {
      let user = await User.findOne({ firebaseUid: decoded.uid });
      if (!user) {
        user = await User.create({
          firebaseUid: decoded.uid,
          email: decoded.email || '',
          name: decoded.name || decoded.email?.split('@')[0] || '',
          role: validRoles.includes(claimedRole) ? claimedRole : ''
        });
      }

      // Sync role from frontend if DB user has no role but frontend does
      // (handles the case where role save previously failed)
      if ((!user.role || user.role === '') && validRoles.includes(claimedRole)) {
        user.role = claimedRole;
        try { await user.save(); } catch {}
      }

      // Sync email verification status from Firebase
      const fbVerified = !!decoded.email_verified;
      if (user.emailVerified !== fbVerified) {
        user.emailVerified = fbVerified;
        try { await user.save(); } catch {}
      }

      // Auto-downgrade expired pro plans
      if (user.plan === 'pro' && user.planExpiresAt && new Date(user.planExpiresAt) < new Date()) {
        user.plan = 'free';
        user.planExpiresAt = null;
        try { await user.save(); } catch {}
      }

      req.user = user;
    } catch (dbErr) {
      dbAvailable = false;
      console.warn('Auth DB lookup failed (MongoDB may be down):', dbErr.message);
      // Create a virtual user object — use claimed role from frontend
      req.user = {
        _isVirtual: true,
        firebaseUid: decoded.uid,
        email: decoded.email || '',
        name: decoded.name || decoded.email?.split('@')[0] || '',
        role: validRoles.includes(claimedRole) ? claimedRole : '',
        plan: 'free',
        dailySearches: 0,
        dailyApplications: 0,
        save: async () => { throw new Error('MongoDB unavailable'); }
      };
    }
    req.dbAvailable = dbAvailable;
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth — attaches user if token present, but doesn't block
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || !parts[1]) { req.user = null; return next(); }
    const token = parts[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUid = decoded.uid;
    try {
      req.user = await User.findOne({ firebaseUid: decoded.uid });
    } catch {
      req.user = null;
    }
    next();
  } catch {
    req.user = null;
    next();
  }
}

module.exports = { requireAuth, optionalAuth };
