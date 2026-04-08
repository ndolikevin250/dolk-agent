const mongoose = require('mongoose');

const oauthStateSchema = new mongoose.Schema({
  state: { type: String, required: true, unique: true, index: true },
  token: { type: String, default: null },
  dbUser: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, expires: 120 } // 2-minute TTL
});

module.exports = mongoose.model('OAuthState', oauthStateSchema);
