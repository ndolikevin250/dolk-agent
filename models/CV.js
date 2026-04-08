const mongoose = require('mongoose');

const cvSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  fileName: { type: String, required: true },
  mimeType: { type: String, default: 'application/pdf' },
  data: { type: Buffer, required: true },
  size: { type: Number, required: true },
  uploadedAt: { type: Date, default: Date.now, expires: 86400 } // 24-hour TTL
});

module.exports = mongoose.model('CV', cvSchema);
