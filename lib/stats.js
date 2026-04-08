// ─── IN-MEMORY STATS (reset on server restart) ─────────
// These counters track activity without persisting to the database.
// The admin dashboard displays them with a "since restart" label.

const stats = {
  totalSearches: 0,
  totalApplicationsSent: 0,
  totalCVsUploaded: 0,
  serverStartedAt: new Date()
};

module.exports = stats;
