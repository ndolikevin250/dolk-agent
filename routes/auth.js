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

module.exports = router;
