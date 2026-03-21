require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']); // Use Google DNS for SRV lookups
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000' }));
app.use(express.json({ limit: '10mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ─── MONGODB ────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err.message));

// ─── ROUTES ─────────────────────────────────────────────
app.use('/api/chat', require('./routes/chat'));
app.use('/api/session', require('./routes/session'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api', require('./routes/email'));
app.use('/api/applications', require('./routes/applications'));
app.use('/api', require('./routes/cv'));

// ─── START ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dolk_agent server running on http://localhost:${PORT}`));
