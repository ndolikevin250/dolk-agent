// ─── FREEMIUM USAGE LIMITS ───────────────────────────────
// Free: 5 searches/day, 3 applications/day
// Pro:  unlimited

const LIMITS = {
  free: { searches: 5, applications: 3 },
  pro: { searches: Infinity, applications: Infinity }
};

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function resetIfNewDay(user) {
  const today = todayStr();
  if (user.lastResetDate !== today) {
    user.dailySearches = 0;
    user.dailyApplications = 0;
    user.lastResetDate = today;
    await user.save();
  }
}

// Middleware: check search limit
function checkSearchLimit(req, res, next) {
  if (!req.user) return next(); // no auth = no limit (dev mode)

  resetIfNewDay(req.user).then(() => {
    const plan = req.user.plan || 'free';
    const limit = LIMITS[plan]?.searches ?? LIMITS.free.searches;

    if (req.user.dailySearches >= limit) {
      return res.status(429).json({
        error: 'Daily search limit reached',
        limit,
        plan,
        upgrade: plan === 'free'
      });
    }
    next();
  }).catch(err => {
    console.error('Usage check error:', err.message);
    next(); // fail open — don't block on DB errors
  });
}

// Middleware: check application limit
function checkApplicationLimit(req, res, next) {
  if (!req.user) return next();

  resetIfNewDay(req.user).then(() => {
    const plan = req.user.plan || 'free';
    const limit = LIMITS[plan]?.applications ?? LIMITS.free.applications;

    if (req.user.dailyApplications >= limit) {
      return res.status(429).json({
        error: 'Daily application limit reached',
        limit,
        plan,
        upgrade: plan === 'free'
      });
    }
    next();
  }).catch(err => {
    console.error('Usage check error:', err.message);
    next();
  });
}

// Call after a successful search to increment counter (atomic to prevent race conditions)
async function incrementSearches(user) {
  if (!user) return;
  const today = todayStr();
  const update = user.lastResetDate !== today
    ? { $set: { dailySearches: 1, dailyApplications: 0, lastResetDate: today } }
    : { $inc: { dailySearches: 1 } };
  const User = require('../models/User');
  const updated = await User.findByIdAndUpdate(user._id, update, { new: true });
  if (updated) {
    user.dailySearches = updated.dailySearches;
    user.dailyApplications = updated.dailyApplications;
    user.lastResetDate = updated.lastResetDate;
  }
}

// Call after a successful application to increment counter (atomic to prevent race conditions)
async function incrementApplications(user) {
  if (!user) return;
  const today = todayStr();
  const update = user.lastResetDate !== today
    ? { $set: { dailyApplications: 1, dailySearches: 0, lastResetDate: today } }
    : { $inc: { dailyApplications: 1 } };
  const User = require('../models/User');
  const updated = await User.findByIdAndUpdate(user._id, update, { new: true });
  if (updated) {
    user.dailySearches = updated.dailySearches;
    user.dailyApplications = updated.dailyApplications;
    user.lastResetDate = updated.lastResetDate;
  }
}

module.exports = { checkSearchLimit, checkApplicationLimit, incrementSearches, incrementApplications, LIMITS };
