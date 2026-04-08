const mongoose = require('mongoose');

const jobPostSchema = new mongoose.Schema({
  employerId: { type: String, required: true, index: true }, // Firebase UID or 'ai_discovery'
  employerEmail: { type: String, default: '' },
  title: { type: String, required: true },
  company: { type: String, required: true },
  location: { type: String, required: true },
  type: { type: String, enum: ['Full-time', 'Part-time', 'Contract', 'Internship', 'Freelance'], default: 'Full-time' },
  description: { type: String, required: true },
  requirements: { type: String, default: '' },
  salary_min: { type: Number, default: null },
  salary_max: { type: Number, default: null },
  salary_currency: { type: String, default: 'USD' },
  contactEmail: { type: String, default: '' },
  deadline: { type: Date, default: null },
  status: { type: String, enum: ['active', 'closed', 'draft'], default: 'active' },
  is_remote: { type: Boolean, default: false },
  categories: [{ type: String }],
  tags: [{ type: String }],
  // Discovery fields
  source: { type: String, enum: ['employer', 'discovered'], default: 'employer', index: true },
  sourceUrl: { type: String, default: null },       // Original posting URL
  discoveredAt: { type: Date, default: null },       // When pipeline found it
  discoveryQuery: { type: String, default: null },   // What search produced this
  dedupeHash: { type: String, default: null, index: true }, // For preventing duplicates
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

jobPostSchema.index({ title: 'text', description: 'text', company: 'text', location: 'text' });
jobPostSchema.pre('save', function () { this.updatedAt = new Date(); });

module.exports = mongoose.model('JobPost', jobPostSchema);
