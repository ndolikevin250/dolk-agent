const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  jobTitle: { type: String, required: true },
  company: { type: String, required: true },
  location: { type: String, default: '' },
  emailTo: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
  cvAttached: { type: Boolean, default: false },
  status: { type: String, enum: ['sent', 'followed_up', 'replied', 'rejected', 'offered'], default: 'sent' },
  jobUrl: { type: String, default: '' },
  matchScore: { type: Number, default: 0 },
  sentAt: { type: Date, default: Date.now },
  followUpDate: { type: Date, default: null },
  followedUpAt: { type: Date, default: null },
  notes: { type: String, default: '' }
});

module.exports = mongoose.model('Application', applicationSchema);
