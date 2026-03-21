const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  cvText: { type: String, default: '' },
  cvName: { type: String, default: '' },
  cvData: { type: Object, default: {} },
  cvFile: { type: Buffer, default: null },
  cvMimeType: { type: String, default: '' },
  chatHistory: { type: Array, default: [] },
  jobs: { type: Array, default: [] },
  appliedJobs: { type: Array, default: [] },
  userPrefs: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now, expires: 2592000 } // auto-delete after 30 days
});

sessionSchema.pre('save', function () { this.updatedAt = new Date(); });

module.exports = mongoose.model('Session', sessionSchema);
