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

let mongoConnected = false;

mongoose.connect(process.env.MONGODB_URI, mongooseOptions)
  .then(() => {
    mongoConnected = true;
    console.log('✓ MongoDB connected successfully');
  })
  .catch(err => {
    mongoConnected = false;
    console.error('✗ MongoDB connection error:', err.message);
  });

// Monitor connection events
mongoose.connection.on('connected', () => {
  mongoConnected = true;
  console.log('✓ Mongoose connected to', mongoose.connection.host);
});

mongoose.connection.on('error', (err) => {
  mongoConnected = false;
  console.error('✗ Mongoose connection error:', err.message);
});

mongoose.connection.on('disconnected', () => {
  mongoConnected = false;
  console.warn('⚠ Mongoose disconnected - attempting to reconnect...');
});

mongoose.connection.on('reconnected', () => {
  mongoConnected = true;
  console.log('✓ Mongoose successfully reconnected');
});

// Graceful shutdown
process.on('SIGINT', () => {
  mongoose.connection.close();
  console.log('Mongoose connection closed');
  process.exit(0);
});

// ─── HEALTH CHECK (Render monitoring) ────────────────────
app.get('/api/health', (req, res) => {
  const mongoState = mongoose.connection.readyState;
  const stateNames = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    status: (mongoConnected && mongoState === 1) ? 'healthy' : 'degraded',
    mongodb: mongoConnected ? 'connected' : 'disconnected',
    readyState: mongoState,
    uptime: Math.floor(process.uptime()),
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
app.use('/api/auth', require('./routes/auth'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/employer', require('./routes/employer'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/discovery', require('./routes/discovery'));
app.use('/api/session', require('./routes/session'));
app.use('/api/applications', require('./routes/applications'));

// ─── ADMIN PANEL (LOCAL ONLY) - MUST BE BEFORE '/api' CATCH-ALL ─────────────────────────────
if (process.env.ADMIN_SECRET) {
  try {
    const adminRoutes = require('./admin/routes');
    console.log('Admin routes loaded:', typeof adminRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/admin', express.static(path.join(__dirname, 'admin')));
    console.log('✓ Admin panel loaded');
  } catch (err) {
    console.error('⚠ Admin panel load error:', err);
    console.warn('⚠ Admin panel not found - skipped (expected in production)');
  }
} else {
  console.log('⚠ ADMIN_SECRET not set - admin panel disabled');
}

// ─── GENERIC API ROUTES (email, cv) - MOUNTED LAST ─────────────────────────────
app.use('/api', require('./routes/email'));
app.use('/api', require('./routes/cv'));

// ─── START ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dolk_agent server running on http://localhost:${PORT}`));
