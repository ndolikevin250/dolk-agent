const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true },
  name: { type: String, default: '' },
  phone: { type: String, default: '' },
  location: { type: String, default: '' },
  bio: { type: String, default: '' },
  emailVerified: { type: Boolean, default: false },
  role: { type: String, enum: ['job_seeker', 'employer', ''], default: '' },
  plan: { type: String, enum: ['free', 'pro'], default: 'free' },
  dailySearches: { type: Number, default: 0 },
  dailyApplications: { type: Number, default: 0 },
  lastResetDate: { type: String, default: '' },
  planExpiresAt: { type: Date, default: null },
  // Employer-specific
  companyName: { type: String, default: '' },
  companyWebsite: { type: String, default: '' },
  // Job seeker-specific
  preferredRole: { type: String, default: '' },
  preferredLocation: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
