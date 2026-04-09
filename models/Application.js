const mongoose = require('mongoose');

// Application tracking - who applied where and when
const applicationSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, index: true }, // Job seeker
  jobId: { type: String, required: true }, // External job ID from API
  jobTitle: String,
  company: String,
  jobSource: { type: String, enum: ['jsearch', 'adzuna', 'remotive', 'local', 'discovered'], default: 'jsearch' },
  
  // Application details
  appliedAt: { type: Date, default: Date.now, index: true },
  status: { 
    type: String, 
    enum: ['draft', 'sent', 'rejected', 'shortlisted', 'interview', 'offered', 'completed'],
    default: 'sent',
    index: true
  },
  
  // Tracking email sent
  emailSentAt: Date,
  coverLetterUsed: Boolean,
  coverLetterText: String,
  
  // Follow-up tracking
  lastFollowUpAt: Date,
  followUpCount: { type: Number, default: 0 },
  nextFollowUpAt: Date,
  
  // Notes
  notes: String,
  feedback: String, // From employer if provided
  
  // De-duplication: track if already applied to prevent duplicate submissions
  appliedJobUrl: String,
  
  // Metadata
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Indexes for faster queries
applicationSchema.index({ firebaseUid: 1, appliedAt: -1 });
applicationSchema.index({ firebaseUid: 1, status: 1 });
applicationSchema.index({ firebaseUid: 1, nextFollowUpAt: 1 }); // For follow-up scheduling

module.exports = mongoose.model('Application', applicationSchema);
