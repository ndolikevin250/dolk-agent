const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const { fetch } = require('undici');
const JobPost = require('../models/JobPost');
const { requireAuth } = require('../middleware/auth');

const GROQ_KEY = process.env.GROQ_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

// ─── SerpApi Result Cache (24h TTL — saves API calls on repeated queries) ──
const searchCacheSchema = new mongoose.Schema({
  queryHash: { type: String, required: true, unique: true, index: true },
  query: { type: String },
  source: { type: String }, // 'serpapi' or 'ddg'
  results: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, expires: 86400 } // TTL: 24 hours
});
const SearchCache = mongoose.model('SearchCache', searchCacheSchema);

function queryCacheKey(query) {
  return crypto.createHash('md5').update(query.toLowerCase().trim()).digest('hex');
}

async function getCachedSearch(query) {
  try {
    const cached = await SearchCache.findOne({ queryHash: queryCacheKey(query) });
    if (cached) {
      console.log(`[Cache] HIT for "${query}" (${cached.source}, ${cached.results.length} results)`);
      return { source: cached.source, results: cached.results };
    }
  } catch (err) {
    console.error('[Cache] Read error:', err.message);
  }
  return null;
}

async function setCachedSearch(query, source, results) {
  try {
    await SearchCache.findOneAndUpdate(
      { queryHash: queryCacheKey(query) },
      { query, source, results, createdAt: new Date() },
      { upsert: true }
    );
  } catch (err) {
    console.error('[Cache] Write error:', err.message);
  }
}

// ─── SerpApi Quota Tracking (free tier = 100 searches/month) ──
const SERPAPI_MONTHLY_LIMIT = 250;
const serpApiUsage = { month: new Date().getMonth(), year: new Date().getFullYear(), count: 0 };

function getSerpApiUsage() {
  const now = new Date();
  // Reset counter on new month
  if (now.getMonth() !== serpApiUsage.month || now.getFullYear() !== serpApiUsage.year) {
    serpApiUsage.month = now.getMonth();
    serpApiUsage.year = now.getFullYear();
    serpApiUsage.count = 0;
  }
  return serpApiUsage;
}

function canUseSerpApi() {
  const usage = getSerpApiUsage();
  return usage.count < SERPAPI_MONTHLY_LIMIT;
}

function recordSerpApiCall() {
  const usage = getSerpApiUsage();
  usage.count++;
  const remaining = SERPAPI_MONTHLY_LIMIT - usage.count;
  if (remaining <= 20) {
    console.warn(`[SerpApi Quota] ${usage.count}/${SERPAPI_MONTHLY_LIMIT} used this month — ${remaining} remaining!`);
  }
}

function getSerpApiRemaining() {
  const usage = getSerpApiUsage();
  return SERPAPI_MONTHLY_LIMIT - usage.count;
}

// Rwanda/East Africa focused search queries — rotated by cron
const DISCOVERY_QUERIES = [
  'job openings Kigali Rwanda',
  'hiring Rwanda',
  'NGO jobs Rwanda East Africa',
  'IT software developer jobs Kigali',
  'finance accounting jobs Rwanda',
  'hospitality tourism jobs Kigali Rwanda',
  'teaching education jobs Rwanda',
  'healthcare nursing jobs Kigali',
  'engineering jobs Rwanda East Africa',
  'marketing sales jobs Kigali Rwanda',
  'agriculture agribusiness jobs Rwanda',
  'internships entry level jobs Kigali Rwanda',
  'UN international organization jobs Rwanda',
  'construction real estate jobs Kigali',
  'logistics supply chain jobs Rwanda',
  'remote jobs hiring Rwanda East Africa'
];

function makeDedupeHash(title, company, location) {
  const normalized = `${title}|${company}|${location}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('md5').update(normalized).digest('hex');
}

// ─── STEP 1A: SerpApi Google Jobs — structured job data from Google ──
async function serpApiGoogleJobs(query, retries = 1) {
  // Check cache first (saves API calls on repeated/similar queries)
  const cached = await getCachedSearch(query);
  if (cached) return cached;

  if (!SERPAPI_KEY) {
    console.log('[SerpApi] No API key, falling back to DuckDuckGo');
    const results = await ddgSearch(query);
    if (results.length > 0) await setCachedSearch(query, 'ddg', results);
    return { source: 'ddg', results };
  }

  if (!canUseSerpApi()) {
    console.warn(`[SerpApi] Monthly quota exhausted (${SERPAPI_MONTHLY_LIMIT}/${SERPAPI_MONTHLY_LIMIT}), falling back to DuckDuckGo`);
    const results = await ddgSearch(query);
    if (results.length > 0) await setCachedSearch(query, 'ddg', results);
    return { source: 'ddg', results };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const params = new URLSearchParams({
        engine: 'google_jobs',
        q: query,
        api_key: SERPAPI_KEY,
        hl: 'en',
        gl: 'rw'  // Google country: Rwanda
      });

      const r = await fetch(`https://serpapi.com/search.json?${params}`);

      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.error(`[SerpApi] HTTP ${r.status} for: "${query}" — ${errText}`);
        if (attempt < retries) { await delay(2000); continue; }
        // Fallback to DDG on SerpApi failure
        console.log('[SerpApi] Falling back to DuckDuckGo');
        return { source: 'ddg', results: await ddgSearch(query) };
      }

      const data = await r.json();
      recordSerpApiCall();
      const jobsResults = data.jobs_results || [];

      // SerpApi Google Jobs returns structured data — map to our format
      const results = jobsResults.map(job => ({
        title: job.title || '',
        company: job.company_name || '',
        location: job.location || '',
        description: job.description || '',
        url: (job.apply_options && job.apply_options[0]?.link) || job.share_link || '',
        extensions: job.detected_extensions || {},
        highlights: job.job_highlights || [],
        // Google Jobs already gives us structured fields
        via: job.via || '',
        posted_at: job.detected_extensions?.posted_at || '',
        schedule_type: job.detected_extensions?.schedule_type || '',
        salary: job.detected_extensions?.salary || ''
      }));

      console.log(`[SerpApi] "${query}" → ${results.length} structured jobs`);
      if (results.length > 0) await setCachedSearch(query, 'serpapi', results);
      return { source: 'serpapi', results };
    } catch (err) {
      console.error(`[SerpApi] Error (attempt ${attempt + 1}):`, err.message);
      if (attempt < retries) await delay(2000);
    }
  }

  // Final fallback to DDG
  console.log('[SerpApi] All attempts failed, falling back to DuckDuckGo');
  return { source: 'ddg', results: await ddgSearch(query) };
}

// ─── STEP 1B: DuckDuckGo HTML search — fallback when SerpApi unavailable ──
async function ddgSearch(query, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const params = new URLSearchParams({ q: query, kl: '' });
      const r = await fetch('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        },
        body: params.toString()
      });

      if (!r.ok) {
        console.error(`[DDG] HTTP ${r.status} for: "${query}"`);
        if (attempt < retries) { await delay(3000); continue; }
        return [];
      }

      const html = await r.text();
      const results = [];

      const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        results.push({
          title: match[2].replace(/<[^>]+>/g, '').trim(),
          url: match[1],
          description: ''
        });
      }

      const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let i = 0;
      while ((match = snippetRegex.exec(html)) !== null) {
        if (results[i]) {
          results[i].description = match[1].replace(/<[^>]+>/g, '').trim();
        }
        i++;
      }

      console.log(`[DDG] "${query}" → ${results.length} results`);
      return results;
    } catch (err) {
      console.error(`[DDG] Error (attempt ${attempt + 1}):`, err.message);
      if (attempt < retries) await delay(3000);
    }
  }
  return [];
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── STEP 1C: Rwandan Job Board Scraping — free, no API key, no quota ──
const RW_JOB_BOARDS = [
  {
    name: 'BrighterMonday Rwanda',
    url: (query) => `https://www.brightermonday.co.rw/jobs?q=${encodeURIComponent(query)}`,
    // Scrape job listings from search results page
    parse: (html) => {
      const jobs = [];
      // BrighterMonday uses structured listing cards
      const cardRegex = /<a[^>]+href="(\/jobs\/[^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<p[^>]*class="[^"]*company[^"]*"[^>]*>([\s\S]*?)<\/p>[\s\S]*?<p[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
      let match;
      while ((match = cardRegex.exec(html)) !== null) {
        jobs.push({
          title: match[2].replace(/<[^>]+>/g, '').trim(),
          url: 'https://www.brightermonday.co.rw' + match[1],
          company: match[3].replace(/<[^>]+>/g, '').trim(),
          location: match[4].replace(/<[^>]+>/g, '').trim() || 'Rwanda',
          description: ''
        });
      }
      return jobs;
    }
  }
];

async function scrapeRwandanBoards(query) {
  const allJobs = [];

  for (const board of RW_JOB_BOARDS) {
    try {
      const url = board.url(query);
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html'
        }
      });

      if (!r.ok) {
        console.error(`[BoardScrape] ${board.name} HTTP ${r.status}`);
        continue;
      }

      const html = await r.text();
      const jobs = board.parse(html);
      console.log(`[BoardScrape] ${board.name}: "${query}" → ${jobs.length} jobs`);

      for (const job of jobs) {
        allJobs.push({
          ...job,
          via: board.name
        });
      }
    } catch (err) {
      console.error(`[BoardScrape] ${board.name} error:`, err.message);
    }
  }

  return allJobs;
}

// Convert scraped board jobs to JobPost format
function convertScrapedJobs(scrapedResults, query) {
  const now = new Date();
  return scrapedResults
    .filter(r => r.title && r.company)
    .map(r => ({
      employerId: 'ai_discovery',
      title: String(r.title).slice(0, 200),
      company: String(r.company).slice(0, 150),
      location: String(r.location || 'Rwanda').slice(0, 150),
      type: 'Full-time',
      description: String(r.description || '').slice(0, 3000),
      requirements: '',
      salary_min: null,
      salary_max: null,
      salary_currency: 'RWF',
      contactEmail: '',
      deadline: null,
      is_remote: /remote/i.test(r.title + ' ' + (r.location || '')),
      source: 'discovered',
      sourceUrl: r.url ? String(r.url).slice(0, 500) : null,
      discoveredAt: now,
      discoveryQuery: query,
      status: 'active',
      dedupeHash: makeDedupeHash(r.title, r.company, r.location || 'Rwanda')
    }));
}

// ─── STEP 2A: Direct conversion of SerpApi structured data (no LLM needed) ──
function convertSerpApiJobs(serpResults, query) {
  const validTypes = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Freelance'];
  const now = new Date();

  return serpResults
    .filter(r => r.title && r.company)
    .map(r => {
      // Map schedule_type to our job types
      let type = 'Full-time';
      const scheduleType = (r.schedule_type || '').toLowerCase();
      if (scheduleType.includes('part')) type = 'Part-time';
      else if (scheduleType.includes('contract') || scheduleType.includes('temp')) type = 'Contract';
      else if (scheduleType.includes('intern')) type = 'Internship';
      else if (scheduleType.includes('freelance')) type = 'Freelance';

      // Parse salary if available
      let salaryMin = null, salaryMax = null, salaryCurrency = 'RWF';
      const salaryStr = r.salary || '';
      if (salaryStr) {
        // Try to extract numbers from salary string like "$50K-$80K" or "RWF 500,000"
        const nums = salaryStr.replace(/,/g, '').match(/[\d.]+/g);
        if (nums && nums.length >= 1) {
          salaryMin = parseFloat(nums[0]);
          if (salaryStr.toLowerCase().includes('k')) salaryMin *= 1000;
          if (nums.length >= 2) {
            salaryMax = parseFloat(nums[1]);
            if (salaryStr.toLowerCase().includes('k')) salaryMax *= 1000;
          }
        }
        if (salaryStr.includes('$') || salaryStr.includes('USD')) salaryCurrency = 'USD';
        else if (salaryStr.includes('€') || salaryStr.includes('EUR')) salaryCurrency = 'EUR';
        else if (salaryStr.includes('£') || salaryStr.includes('GBP')) salaryCurrency = 'GBP';
      }

      // Extract requirements + responsibilities from highlights
      let requirements = '';
      let extraDesc = '';
      if (r.highlights && Array.isArray(r.highlights)) {
        for (const section of r.highlights) {
          if (!section.title || !section.items) continue;
          const title = section.title.toLowerCase();
          if (title.includes('qualif') || title.includes('requirement')) {
            requirements = section.items.join('; ');
          } else if (title.includes('responsib') || title.includes('duties')) {
            extraDesc = section.items.slice(0, 5).join('; ');
          }
        }
      }

      const isRemote = /remote/i.test(r.title + ' ' + r.location + ' ' + scheduleType);

      return {
        employerId: 'ai_discovery',
        title: String(r.title).slice(0, 200),
        company: String(r.company).slice(0, 150),
        location: String(r.location).slice(0, 150),
        type,
        description: String((r.description || '') + (extraDesc ? '\n\nKey responsibilities: ' + extraDesc : '')).slice(0, 3000),
        requirements: String(requirements).slice(0, 2000),
        salary_min: salaryMin,
        salary_max: salaryMax,
        salary_currency: salaryCurrency,
        contactEmail: '', // Google Jobs doesn't expose emails
        deadline: null,
        is_remote: isRemote,
        source: 'discovered',
        sourceUrl: r.url ? String(r.url).slice(0, 500) : null,
        discoveredAt: now,
        discoveryQuery: query,
        status: 'active',
        dedupeHash: makeDedupeHash(r.title, r.company, r.location)
      };
    });
}

// ─── STEP 2B: Groq LLM parse — used for DDG fallback (unstructured data) ──
async function groqParseJobs(searchResults, query) {
  if (!GROQ_KEY || searchResults.length === 0) return [];

  const today = new Date().toISOString().split('T')[0];

  const context = searchResults.map((r, i) =>
    `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.description}`
  ).join('\n\n');

  const prompt = `You are a job data extractor specialized in Rwanda and East Africa job markets. Below are web search results for: "${query}"
Today's date: ${today}

SEARCH RESULTS:
${context}

Extract REAL job postings from these results. Return ONLY a JSON array, no other text.

JSON schema per job:
{"title":"string","company":"string","location":"string","type":"Full-time|Part-time|Contract|Internship|Freelance","description":"2-3 sentence summary","requirements":"key qualifications","salary_min":null,"salary_max":null,"salary_currency":"RWF","contactEmail":null,"deadline":null,"is_remote":false,"sourceUrl":"exact URL from results"}

RULES:
- ONLY real job postings — skip career advice articles, job market news, training programs
- Use EXACT URLs from results as sourceUrl — never modify or construct URLs
- Prioritize Rwanda/East Africa jobs. For location, always include the country (e.g. "Kigali, Rwanda" not just "Kigali")
- If a job board page lists multiple jobs visible in the snippet, extract each separately
- contactEmail: ONLY use if an exact email address is literally printed in the snippet. NEVER fabricate emails (no careers@, hr@, info@ guesses). Use null if unsure.
- deadline: extract if a specific date is mentioned (ISO format YYYY-MM-DD). null otherwise.
- Return [] if no clear job postings found`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 4096
      })
    });

    if (!r.ok) {
      console.error(`[Groq] Parse failed: ${r.status}`);
      return [];
    }

    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    return parseJobsJSON(text, query);
  } catch (err) {
    console.error('[Groq] Parse error:', err.message);
    return [];
  }
}

// Reject AI-fabricated emails — only keep emails that look genuinely scraped
function sanitizeDiscoveredEmail(email, company) {
  if (!email || email === 'null' || typeof email !== 'string') return '';
  const e = email.trim().toLowerCase();
  if (!e.includes('@') || e.length > 200) return '';
  // Generic prefixes the AI loves to fabricate from company names
  const genericPrefixes = ['careers@', 'hr@', 'jobs@', 'hiring@', 'recruit@', 'recruitment@', 'apply@', 'talent@', 'info@', 'contact@', 'hello@', 'noreply@'];
  if (genericPrefixes.some(p => e.startsWith(p))) return '';
  return String(email).slice(0, 200);
}

// Parse LLM JSON response into validated job objects
function parseJobsJSON(text, query) {
  let jsonStr = text;
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) jsonStr = codeBlockMatch[1];

  const arrayStart = jsonStr.indexOf('[');
  const arrayEnd = jsonStr.lastIndexOf(']');
  if (arrayStart === -1 || arrayEnd === -1) return [];
  jsonStr = jsonStr.slice(arrayStart, arrayEnd + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error('[Discovery] Failed to parse Groq JSON');
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const validTypes = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Freelance'];
  const now = new Date();

  return parsed
    .filter(j => j.title && j.company && j.location)
    .map(j => ({
      employerId: 'ai_discovery',
      title: String(j.title).slice(0, 200),
      company: String(j.company).slice(0, 150),
      location: String(j.location).slice(0, 150),
      type: validTypes.includes(j.type) ? j.type : 'Full-time',
      description: String(j.description || '').slice(0, 3000),
      requirements: String(j.requirements || '').slice(0, 2000),
      salary_min: typeof j.salary_min === 'number' ? j.salary_min : null,
      salary_max: typeof j.salary_max === 'number' ? j.salary_max : null,
      salary_currency: String(j.salary_currency || 'RWF').slice(0, 5),
      contactEmail: sanitizeDiscoveredEmail(j.contactEmail, j.company),
      deadline: j.deadline ? new Date(j.deadline) : null,
      is_remote: Boolean(j.is_remote),
      source: 'discovered',
      sourceUrl: j.sourceUrl ? String(j.sourceUrl).slice(0, 500) : null,
      discoveredAt: now,
      discoveryQuery: query,
      status: 'active',
      dedupeHash: makeDedupeHash(j.title, j.company, j.location)
    }));
}

// ─── CORE: Discovery pipeline (SerpApi → DDG fallback → Groq parse if needed) ──
async function runDiscovery(queries) {
  // SerpApi works without Groq (structured data). DDG fallback needs Groq.
  if (!SERPAPI_KEY && !GROQ_KEY) {
    return { error: 'Neither SERPAPI_KEY nor GROQ_API_KEY configured', discovered: 0, stored: 0 };
  }

  // Quota-aware: limit queries based on remaining SerpApi searches
  const remaining = getSerpApiRemaining();
  if (SERPAPI_KEY && remaining <= 10) {
    // Reserve last 10 searches for manual/admin use — cron uses DDG fallback
    console.warn(`[Discovery] Only ${remaining} SerpApi searches left this month — cron will use DDG fallback to conserve quota`);
  }

  let totalDiscovered = 0;
  let totalStored = 0;
  let totalDuplicates = 0;
  let serpApiUsed = 0;
  let ddgFallbacks = 0;
  let boardScraped = 0;
  const errors = [];

  for (const query of queries) {
    try {
      // Step 1: Search multiple sources in parallel
      // SerpApi/DDG for international + board scraping for local Rwanda jobs
      const [searchResult, boardResults] = await Promise.all([
        serpApiGoogleJobs(query),
        scrapeRwandanBoards(query)
      ]);

      const { source, results: searchResults } = searchResult;
      let jobs = [];

      // Process SerpApi/DDG results
      if (searchResults.length > 0) {
        if (source === 'serpapi') {
          serpApiUsed++;
          jobs = convertSerpApiJobs(searchResults, query);
          console.log(`[Discovery] SerpApi: ${jobs.length} structured jobs for: "${query}"`);
        } else {
          ddgFallbacks++;
          if (GROQ_KEY) {
            jobs = await groqParseJobs(searchResults, query);
            console.log(`[Discovery] DDG+Groq: ${jobs.length} jobs from ${searchResults.length} results for: "${query}"`);
          }
        }
      }

      // Process board-scraped results (free, no quota impact)
      if (boardResults.length > 0) {
        boardScraped += boardResults.length;
        const boardJobs = convertScrapedJobs(boardResults, query);
        jobs = [...jobs, ...boardJobs];
        console.log(`[Discovery] Board scrape: ${boardResults.length} local jobs for: "${query}"`);
      }

      if (jobs.length === 0) {
        console.log(`[Discovery] No results for: "${query}" (via ${source})`);
        continue;
      }

      totalDiscovered += jobs.length;

      // Step 2: Store with dedup
      for (const job of jobs) {
        try {
          const existing = await JobPost.findOne({ dedupeHash: job.dedupeHash });
          if (existing) {
            totalDuplicates++;
            continue;
          }
          await JobPost.create(job);
          totalStored++;
        } catch (dbErr) {
          console.error(`[Discovery] DB store error "${job.title}":`, dbErr.message);
          errors.push(`Store failed: ${job.title} — ${dbErr.message}`);
        }
      }

      // Delay between queries to respect rate limits
      if (queries.indexOf(query) < queries.length - 1) {
        await delay(source === 'serpapi' ? 1000 : 4000);
      }
    } catch (err) {
      console.error(`[Discovery] Pipeline error "${query}":`, err.message);
      errors.push(`Query failed: ${query} — ${err.message}`);
    }
  }

  const summary = {
    discovered: totalDiscovered,
    stored: totalStored,
    duplicates: totalDuplicates,
    serpApiQueries: serpApiUsed,
    ddgFallbacks,
    boardScraped,
    serpApiRemaining: getSerpApiRemaining(),
    errors: errors.length,
    errorDetails: errors.slice(0, 10),
    queriesRun: queries.length,
    timestamp: new Date().toISOString()
  };
  console.log('[Discovery] Complete:', JSON.stringify(summary));
  return summary;
}

// ─── QUERY EXPANSION: Use Groq to expand vague queries (manual searches only) ──
async function expandQuery(rawQuery) {
  if (!GROQ_KEY) return rawQuery;
  // Skip expansion for queries that are already specific
  if (rawQuery.split(/\s+/).length >= 5) return rawQuery;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `Expand this job search query for Rwanda/East Africa into a more effective Google Jobs search query. Add relevant synonyms and location context.

Input: "${rawQuery}"

Rules:
- Return ONLY the expanded query string, nothing else
- Keep it under 100 characters
- Add "Rwanda" or "Kigali" if no location is specified
- Add 1-2 relevant job title synonyms using OR
- Example: "coder jobs" → "Software Engineer OR Web Developer jobs Kigali Rwanda"
- Example: "NGO work" → "NGO OR nonprofit OR humanitarian jobs Rwanda"
- Do NOT add quotes or special search operators`
        }],
        temperature: 0.3,
        max_tokens: 100
      })
    });

    if (!r.ok) return rawQuery;
    const data = await r.json();
    const expanded = (data.choices?.[0]?.message?.content || '').trim();
    if (expanded && expanded.length > 3 && expanded.length < 150) {
      console.log(`[QueryExpand] "${rawQuery}" → "${expanded}"`);
      return expanded;
    }
  } catch (err) {
    console.error('[QueryExpand] Error:', err.message);
  }
  return rawQuery;
}

// ─── ROUTES ──────────────────────────────────────────────

// Only allow admin (via admin panel) to trigger manual discovery
function requireAdmin(req, res, next) {
  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Run discovery with default Rwanda queries
router.post('/run', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { categories } = req.body;
    let queries = DISCOVERY_QUERIES;

    if (categories && Array.isArray(categories) && categories.length > 0) {
      const cats = categories.map(c => c.toLowerCase());
      queries = DISCOVERY_QUERIES.filter(q => cats.some(c => q.toLowerCase().includes(c)));
      if (queries.length === 0) queries = DISCOVERY_QUERIES.slice(0, 3);
    }

    // Max 5 queries per manual run
    queries = queries.slice(0, 5);
    const result = await runDiscovery(queries);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Discovery run error:', err);
    res.status(500).json({ error: 'Discovery failed: ' + err.message });
  }
});

// Custom search query (with LLM query expansion)
router.post('/search', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { query, expand } = req.body;
    if (!query || typeof query !== 'string' || query.trim().length < 3) {
      return res.status(400).json({ error: 'Provide a search query (min 3 characters)' });
    }
    const raw = query.trim().slice(0, 200);
    // Expand query by default for manual searches (pass expand:false to skip)
    const finalQuery = expand !== false ? await expandQuery(raw) : raw;
    const result = await runDiscovery([finalQuery]);
    res.json({ success: true, originalQuery: raw, expandedQuery: finalQuery, ...result });
  } catch (err) {
    console.error('Discovery search error:', err);
    res.status(500).json({ error: 'Discovery search failed: ' + err.message });
  }
});

// Discovery stats
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const total = await JobPost.countDocuments({ source: 'discovered' });
    const active = await JobPost.countDocuments({ source: 'discovered', status: 'active' });
    const lastDiscovered = await JobPost.findOne({ source: 'discovered' })
      .sort({ discoveredAt: -1 })
      .select('discoveredAt discoveryQuery title');

    res.json({
      total,
      active,
      serpApi: {
        remaining: getSerpApiRemaining(),
        limit: SERPAPI_MONTHLY_LIMIT,
        used: getSerpApiUsage().count
      },
      lastDiscovery: lastDiscovered ? {
        at: lastDiscovered.discoveredAt,
        query: lastDiscovered.discoveryQuery,
        lastJob: lastDiscovered.title
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Clean expired discovered jobs
router.delete('/cleanup', requireAuth, async (req, res) => {
  try {
    const result = await JobPost.updateMany(
      { source: 'discovered', deadline: { $lt: new Date() }, status: 'active' },
      { $set: { status: 'closed' } }
    );
    res.json({ closed: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// ─── SMART QUERY SELECTION: Pick queries with fewest recent results ──
async function pickSmartQueries(count = 2) {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Count recent jobs per query category
    const queryCounts = await Promise.all(
      DISCOVERY_QUERIES.map(async (query) => {
        const recentCount = await JobPost.countDocuments({
          source: 'discovered',
          discoveryQuery: query,
          discoveredAt: { $gte: sevenDaysAgo }
        });
        return { query, recentCount };
      })
    );

    // Sort by fewest recent results (gaps first), then pick top N
    queryCounts.sort((a, b) => a.recentCount - b.recentCount);
    const selected = queryCounts.slice(0, count).map(q => q.query);
    console.log(`[SmartPick] Selected ${selected.length} queries (least recent results):`, selected.map(q => `"${q}"`).join(', '));
    return selected;
  } catch (err) {
    // Fallback to random if DB query fails
    console.error('[SmartPick] DB error, falling back to random:', err.message);
    const shuffled = [...DISCOVERY_QUERIES].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }
}

module.exports = router;
module.exports.runDiscovery = runDiscovery;
module.exports.pickSmartQueries = pickSmartQueries;
module.exports.DISCOVERY_QUERIES = DISCOVERY_QUERIES;
