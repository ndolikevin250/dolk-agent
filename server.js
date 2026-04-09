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
  maxPoolSize: 10,
  minPoolSize: 2,
  retryWrites: true,
  w: 'majority',
  family: 4,
  connectTimeoutMS: 10000,
  heartbeatFrequencyMS: 30000,
};

mongoose.connect(process.env.MONGODB_URI, mongooseOptions)
  .then(() => console.log('✓ MongoDB connected successfully'))
  .catch(err => console.error('✗ MongoDB connection error:', err.message));

// Monitor connection events
mongoose.connection.on('connected', () => {
  console.log('✓ Mongoose default connection open to', mongoose.connection.host);
});

mongoose.connection.on('error', (err) => {
  console.error('✗ Mongoose connection error:', err.message);
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠ Mongoose connection disconnected - will auto-reconnect');
});

mongoose.connection.on('reconnected', () => {
  console.log('✓ Mongoose reconnected to', mongoose.connection.host);
});

// Graceful shutdown
process.on('SIGINT', () => {
  mongoose.connection.close();
  console.log('Mongoose connection closed due to application termination');
  process.exit(0);
});

// ─── HEALTH CHECK (Render monitoring) ────────────────────
app.get('/api/health', (req, res) => {
  const mongoState = mongoose.connection.readyState;
  const stateNames = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  console.log(`[Health Check] MongoDB state: ${stateNames[mongoState]} (${mongoState})`);
  res.json({
    status: mongoState === 1 ? 'healthy' : 'degraded',
    mongodb: stateNames[mongoState],
    readyState: mongoState,
    timestamp: new Date().toISOString()
  });
});

// ─── CONFIG ENDPOINT (Frontend Firebase config) ────────────
app.get('/api/config', (req, res) => {
  // Return Firebase client config (safe to expose — it's public anyway)
  const config = {
    firebase: {
      apiKey: process.env.FIREBASE_API_KEY || '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
      projectId: process.env.FIREBASE_PROJECT_ID || '',
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
      appId: process.env.FIREBASE_APP_ID || ''
    }
  };
  res.json(config);
});

// ─── ROUTES ─────────────────────────────────────────────
app.use('/api/chat', require('./routes/chat'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api', require('./routes/email'));
app.use('/api', require('./routes/cv'));

// ─── ADMIN PANEL (LOCAL ONLY) ─────────────────────────────
if (process.env.ADMIN_SECRET) {
  try {
    app.use('/api/admin', require('./admin/routes'));
    app.use('/admin', express.static(path.join(__dirname, 'admin')));
    console.log('✓ Admin panel loaded');
  } catch (err) {
    console.warn('⚠ Admin panel not found - skipped (expected in production)');
  }
}

// ─── START ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dolk_agent server running on http://localhost:${PORT}`));
