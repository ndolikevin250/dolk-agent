# Dolk Agent

AI-powered job search and application platform targeting Rwanda/East Africa.

## Stack
- **Backend:** Node.js, Express 5, MongoDB Atlas (Mongoose 9), Firebase Admin Auth
- **Frontend:** Vanilla JS (public/app.js ~2600 lines), no build step
- **AI:** Groq API (llama-3.3-70b-versatile) for chat, cover letters, job scoring
- **Auth:** Firebase Auth (email/password + Google OAuth)
- **Payments:** MTN Mobile Money (free/pro tiers)
- **Email:** Nodemailer (SMTP)
- **Deployment:** Render (render.yaml configured)

## Project Structure
```
server.js          — Express app, middleware, MongoDB connect, route mounting
routes/
  auth.js          — Firebase auth verify, profile, role, account deletion
  jobs.js          — Multi-source job search (JSearch, Adzuna, Remotive, local DB)
  employer.js      — Employer job posting CRUD
  chat.js          — Groq LLM proxy (requireAuth)
  cv.js            — CV upload/parse (PDF, DOCX, TXT) (requireAuth)
  email.js         — Application email sending + follow-ups (requireAuth)
  session.js       — Session save/load/delete (requireAuth + ownership)
  applications.js  — Application tracking (requireAuth + ownership)
  payment.js       — MTN MoMo checkout/status + plan management
  discovery.js     — Brave Search + Groq job discovery pipeline
models/
  User.js          — Firebase-linked user with role, plan, usage counters
  JobPost.js       — Employer-posted jobs with text search index
  Session.js       — CV data, chat history, job results (30-day TTL, firebaseUid ownership)
  Application.js   — Sent applications with status tracking (firebaseUid ownership)
middleware/
  auth.js          — requireAuth, optionalAuth (Firebase token verification)
  usage.js         — Search/application daily limits (free vs pro)
public/
  index.html       — Single page app shell
  app.js           — Full frontend (~2600 lines)
  styles.css       — Dark theme UI
admin/             — Independent admin panel (NOT published with app)
  index.html       — Admin SPA (passphrase auth, dark theme)
  routes.js        — Admin API routes (CRUD all models, stats, activity, env)
```

## Key Architecture Decisions
- Local DB jobs always appear first in search results (employer-posted > API results)
- Sessions use client-generated IDs (sess_ + random hex), stored in sessionStorage
- MongoDB graceful degradation: app works with limited functionality when Atlas is unreachable
- No build step — public/ served as static files directly
- Firebase Admin initialized in server.js, middleware verifies tokens per-request

## Environment Variables
All secrets in .env (gitignored). Required (server won't start without):
- MONGODB_URI, FIREBASE_SERVICE_ACCOUNT (JSON)
- FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID

Optional (features degrade gracefully):
- SERPAPI_KEY — SerpApi Google Jobs (primary discovery source, 250 free/month)
- GROQ_API_KEY, JSEARCH_API_KEY, ADZUNA_APP_ID, ADZUNA_APP_KEY
- MOMO_COLLECTION_SUBSCRIPTION_KEY, MOMO_API_USER_ID, MOMO_API_KEY, MOMO_TARGET_ENVIRONMENT, MOMO_BASE_URL
- SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM_NAME
- GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
- CORS_ORIGIN, PORT, NODE_ENV
- ADMIN_SECRET — enables admin panel at /admin (passphrase auth)

## Development
- `npm run dev` — starts with nodemon
- `npm start` — production start
- Always start the dev server after making code changes (user preference)
- MongoDB Atlas IP whitelist issues are common (user's ISP changes IP)

## Job Discovery Pipeline (SerpApi + Board Scraping + DDG fallback)
- `routes/discovery.js` — Multi-source discovery pipeline:
  1. **SerpApi Google Jobs** (primary) — structured data, no LLM needed, `gl=rw` for Rwanda
  2. **Rwandan job board scraping** (free, parallel) — BrighterMonday Rwanda, runs alongside SerpApi
  3. **DuckDuckGo + Groq** (fallback) — when SerpApi key missing or quota exhausted
- **Quota management**: In-memory tracker, 250 searches/month free tier. Auto-fallback to DDG when exhausted. Last 10 reserved for manual use.
- **24h result cache**: SearchCache model in MongoDB (TTL index), prevents duplicate API calls for same queries
- **Smart cron rotation**: Picks 2 categories with fewest recent results (fills gaps, not random)
- **LLM query expansion**: Manual /search endpoint auto-expands vague queries via Groq (e.g. "coder jobs" → "Software Engineer OR Web Developer Kigali Rwanda")
- Cron runs once daily at 6 AM UTC (8 AM Kigali), 3 queries/run = ~90 SerpApi searches/month
- Endpoints: POST /api/discovery/run, POST /api/discovery/search (with expansion), GET /api/discovery/stats (includes quota), DELETE /api/discovery/cleanup
- Requires: SERPAPI_KEY (primary) or GROQ_API_KEY (DDG fallback). Both is ideal.
- Existing APIs (JSearch, Adzuna, Remotive) untouched — supplementary for international searches

## Admin Panel (LOCAL ONLY — DO NOT PUBLISH)
- Located in `admin/` folder — **MUST be excluded from any deploy, push, or publish**
- Before deploying or pushing: remove `admin/` from the build, or add it to `.renderignore` / deploy exclusion
- In server.js the admin routes are gated behind `ADMIN_SECRET` env var — do NOT set this in production
- If deploying to Render: do NOT add ADMIN_SECRET to Render env vars — this disables admin in production automatically
- Access locally at `/admin` when ADMIN_SECRET is set in .env
- Uses its own passphrase auth (not Firebase) — completely independent
- Full CRUD for users, sessions, applications, jobs
- Dashboard with stats, activity timeline, env config viewer
- Can add jobs directly, bulk-delete old sessions, manage user plans/roles

### Pre-publish checklist for admin safety
1. Ensure `admin/` is NOT included in the deployed files
2. Ensure ADMIN_SECRET is NOT set in production environment variables
3. If using git: add `admin/` to `.gitignore` before pushing to any public/shared repo

## Known Issues (Pre-release)
- No CSRF protection
- No graceful shutdown handler
- No structured logging
