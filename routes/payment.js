const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many requests. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false
});
router.use(paymentLimiter);

// ─── CONFIG ─────────────────────────────────────────────
const MOMO_SUB_KEY = process.env.MOMO_COLLECTION_SUBSCRIPTION_KEY;
const MOMO_API_USER = process.env.MOMO_API_USER_ID;
const MOMO_API_KEY = process.env.MOMO_API_KEY;
const MOMO_ENV = process.env.MOMO_TARGET_ENVIRONMENT || 'sandbox';
const MOMO_CURRENCY = process.env.MOMO_CURRENCY || (MOMO_ENV === 'sandbox' ? 'EUR' : 'RWF');
const MOMO_BASE = process.env.MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com';
const MOMO_CALLBACK = process.env.MOMO_CALLBACK_URL || '';

const PRO_AMOUNT_RWF = parseInt(process.env.PRO_PRICE_RWF || '5000'); // 5000 RWF

const momoEnabled = !!(MOMO_SUB_KEY && MOMO_API_USER && MOMO_API_KEY);

// ─── HELPERS ────────────────────────────────────────────
const PRO_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function upgradeUser(firebaseUid) {
  const user = await User.findOne({ firebaseUid });
  if (user && user.plan !== 'pro') {
    user.plan = 'pro';
    user.planExpiresAt = new Date(Date.now() + PRO_DURATION_MS);
    await user.save();
    console.log(`User ${user.email} upgraded to Pro`);
    return user;
  }
  return user;
}

// ─── MTN MoMo: Token cache ─────────────────────────────
let momoToken = null;
let momoTokenExpiry = 0;

async function getMomoToken() {
  if (momoToken && Date.now() < momoTokenExpiry - 60000) return momoToken;

  const auth = Buffer.from(MOMO_API_USER + ':' + MOMO_API_KEY).toString('base64');
  const r = await fetch(MOMO_BASE + '/collection/token/', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Ocp-Apim-Subscription-Key': MOMO_SUB_KEY,
      'X-Target-Environment': MOMO_ENV
    }
  });
  if (!r.ok) throw new Error('MoMo token request failed: ' + r.status);
  const data = await r.json();
  momoToken = data.access_token;
  momoTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return momoToken;
}

// ─── AVAILABLE METHODS ──────────────────────────────────
router.get('/methods', requireAuth, (req, res) => {
  const methods = [];
  if (momoEnabled) methods.push({ id: 'momo', name: 'MTN Mobile Money', currency: MOMO_CURRENCY, amount: PRO_AMOUNT_RWF });
  res.json({ methods, plan: req.user.plan || 'free' });
});

// ─── MOMO: Request to Pay ───────────────────────────────
router.post('/momo/checkout', requireAuth, async (req, res) => {
  try {
    if (!momoEnabled) return res.status(503).json({ error: 'MTN MoMo not configured' });
    if (req.user.plan === 'pro') return res.json({ ok: true, alreadyPro: true });

    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    // Validate phone format (Rwanda: 250 + 9 digits)
    const cleaned = phoneNumber.replace(/\s+/g, '').replace(/^(\+|00)/, '');
    if (!/^250\d{9}$/.test(cleaned)) {
      return res.status(400).json({ error: 'Invalid phone number. Use format: 250780000000' });
    }

    const token = await getMomoToken();
    const referenceId = crypto.randomUUID();
    const externalId = 'dolk_' + req.user.firebaseUid + '_' + Date.now();

    const headers = {
      'Authorization': 'Bearer ' + token,
      'X-Reference-Id': referenceId,
      'X-Target-Environment': MOMO_ENV,
      'Ocp-Apim-Subscription-Key': MOMO_SUB_KEY,
      'Content-Type': 'application/json'
    };
    if (MOMO_CALLBACK) headers['X-Callback-Url'] = MOMO_CALLBACK;

    const r = await fetch(MOMO_BASE + '/collection/v1_0/requesttopay', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        amount: String(PRO_AMOUNT_RWF),
        currency: MOMO_CURRENCY,
        externalId,
        payer: { partyIdType: 'MSISDN', partyId: cleaned },
        payerMessage: 'Dolk Agent Pro — 30 days',
        payeeNote: 'Pro plan upgrade'
      })
    });

    if (r.status !== 202) {
      const err = await r.text();
      console.error('MoMo request-to-pay failed:', r.status, err);
      return res.status(500).json({ error: 'Failed to initiate MoMo payment. Please try again.' });
    }

    res.json({
      ok: true,
      referenceId,
      message: 'Payment request sent to your phone. Please approve the prompt on your phone.'
    });
  } catch (err) {
    console.error('MoMo checkout error:', err);
    res.status(500).json({ error: 'MoMo payment failed' });
  }
});

// ─── MOMO: Check payment status (frontend polls this) ───
router.post('/momo/status', requireAuth, async (req, res) => {
  try {
    const { referenceId } = req.body;
    if (!referenceId || !momoEnabled) return res.status(400).json({ error: 'referenceId required' });

    const token = await getMomoToken();
    const r = await fetch(MOMO_BASE + '/collection/v1_0/requesttopay/' + referenceId, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'X-Target-Environment': MOMO_ENV,
        'Ocp-Apim-Subscription-Key': MOMO_SUB_KEY
      }
    });

    if (!r.ok) return res.status(500).json({ error: 'Failed to check status' });
    const data = await r.json();

    if (data.status === 'SUCCESSFUL') {
      await upgradeUser(req.user.firebaseUid);
      return res.json({ ok: true, status: 'SUCCESSFUL', plan: 'pro' });
    }

    if (data.status === 'FAILED') {
      const reason = data.reason?.code || 'Unknown error';
      return res.json({ ok: false, status: 'FAILED', reason });
    }

    res.json({ ok: false, status: 'PENDING' });
  } catch (err) {
    console.error('MoMo status error:', err);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ─── PLAN STATUS ────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    const plan = req.user.plan || 'free';
    const expiresAt = req.user.planExpiresAt;
    const isExpired = expiresAt && new Date(expiresAt) < new Date();

    if (plan === 'pro' && isExpired) {
      req.user.plan = 'free';
      req.user.planExpiresAt = null;
      await req.user.save();
      return res.json({ plan: 'free', expired: true });
    }

    res.json({ plan, expiresAt });
  } catch (err) {
    console.error('Plan status error:', err);
    res.status(500).json({ error: 'Failed to check plan status' });
  }
});

// ─── MANUAL UPGRADE (testing/admin) – requires special header ───
router.post('/upgrade-manual', requireAuth, async (req, res) => {
  try {
    // Optional: gate this behind ADMIN_SECRET if in production
    const adminSecret = process.env.ADMIN_SECRET;
    const headerSecret = req.headers['x-admin-secret'];

    if (adminSecret && headerSecret !== adminSecret) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const user = await upgradeUser(req.user.firebaseUid);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      ok: true,
      plan: user.plan,
      expiresAt: user.planExpiresAt,
      message: `User ${user.email} upgraded to Pro (30 days)`
    });
  } catch (err) {
    console.error('Manual upgrade error:', err);
    res.status(500).json({ error: 'Manual upgrade failed' });
  }
});

module.exports = router;
