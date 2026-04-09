const mongoose = require('mongoose');

// TTL index: Auto-delete documents 30 days after creation
const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true }, // sess_<random> or u_<firebaseUid>
  firebaseUid: { type: String, required: true, index: true }, // Owner verification
  
  // Session data (ephemeral - not persisted long-term)
  cvText: { type: String, default: '' }, // Extracted CV text
  cvName: { type: String, default: '' }, // Original CV filename
  cvData: { type: mongoose.Schema.Types.Mixed, default: {} }, // Parsed CV metadata
  
  // Chat history (last ~10 messages to keep size down)
  chatHistory: [{ 
    role: { type: String, enum: ['system', 'user', 'assistant'], required: true },
    content: { type: String, maxlength: 10000, required: true }
  }],
  
  // Job search results
  jobResults: [{ 
    id: { type: String, unique: false }, // Job listing ID
    title: String,
    company: String,
    location: String,
    salary: String,
    url: String,
    source: { type: String, enum: ['jsearch', 'adzuna', 'remotive', 'local', 'discovered'], default: 'jsearch' },
    matchScore: Number // 0-100 from AI matching
  }],
  
  // User preferences (location, job type, salary expectations)
  userPrefs: {
    locations: [String],
    jobTypes: [String],
    salaryMin: Number,
    salaryMax: Number,
    skills: [String]
  },
  
  // Applied jobs tracking (for deduplication)
  appliedJobIds: [{ type: String }],
  
  // Metadata
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), index: { expireAfterSeconds: 0 } } // TTL
}, { timestamps: true });

// Index for faster queries
sessionSchema.index({ firebaseUid: 1, createdAt: -1 });

module.exports = mongoose.model('Session', sessionSchema);
