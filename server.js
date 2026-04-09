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
const mongooseOptions = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  retryWrites: true,
  w: 'majority',
  family: 4
};

mongoose.connect(process.env.MONGODB_URI, mongooseOptions)
  .then(() => console.log('✓ MongoDB connected successfully'))
  .catch(err => console.error('✗ MongoDB connection error:', err.message));

// Monitor connection events
mongoose.connection.on('connected', () => {
  console.log('✓ Mongoose default connection open to', mongoose.connection.host);
});

mongoose.connection.on('error', (err) => {
  console.error('✗ Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠ Mongoose connection disconnected');
});

// Graceful shutdown
process.on('SIGINT', () => {
  mongoose.connection.close();
  console.log('Mongoose connection closed due to application termination');
  process.exit(0);
});

// ─── ROUTES ─────────────────────────────────────────────
app.use('/api/chat', require('./routes/chat'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api', require('./routes/email'));
app.use('/api', require('./routes/cv'));

// ─── ADMIN PANEL (LOCAL ONLY) ─────────────────────────────
if (process.env.ADMIN_SECRET) {
  app.use('/api/admin', require('./admin/routes'));
  app.use('/admin', express.static(path.join(__dirname, 'admin')));
}

// ─── START ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dolk_agent server running on http://localhost:${PORT}`));
