const express = require('express');
const router = express.Router();

const JSEARCH_KEY = process.env.JSEARCH_API_KEY;
const ADZUNA_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_KEY = process.env.ADZUNA_APP_KEY;

// Adzuna supported countries
const ADZUNA_COUNTRIES = {
  'south africa': 'za', 'johannesburg': 'za', 'cape town': 'za', 'durban': 'za',
  'united states': 'us', 'usa': 'us', 'us': 'us',
  'united kingdom': 'gb', 'uk': 'gb', 'london': 'gb', 'england': 'gb',
  'canada': 'ca', 'toronto': 'ca', 'vancouver': 'ca',
  'australia': 'au', 'sydney': 'au', 'melbourne': 'au',
  'germany': 'de', 'berlin': 'de', 'munich': 'de',
  'france': 'fr', 'paris': 'fr',
  'india': 'in', 'mumbai': 'in', 'delhi': 'in', 'bangalore': 'in',
  'netherlands': 'nl', 'amsterdam': 'nl',
  'brazil': 'br', 'singapore': 'sg',
  'poland': 'pl', 'austria': 'at', 'new zealand': 'nz',
};

function getAdzunaCountry(location) {
  if (!location) return null;
  const loc = location.toLowerCase();
  for (const [key, code] of Object.entries(ADZUNA_COUNTRIES)) {
    if (loc.includes(key)) return code;
  }
  return null;
}

async function fetchJSearch(query, location, remoteOnly, datePosted) {
  if (!JSEARCH_KEY) return [];
  try {
    const searchQuery = location ? `${query} in ${location}` : query;
    const queries = [searchQuery];
    if (location) {
      const parts = location.split(',').map(s => s.trim());
      if (parts.length > 1) queries.push(`${query} in ${parts[parts.length - 1]}`);
    }

    const seen = new Set();
    const results = [];

    for (const q of queries) {
      const params = new URLSearchParams({ query: q, page: '1', num_pages: '1', date_posted: datePosted });
      if (remoteOnly) params.append('remote_jobs_only', 'true');
      try {
        const r = await fetch(`https://jsearch.p.rapidapi.com/search?${params}`, {
          headers: { 'X-RapidAPI-Key': JSEARCH_KEY, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' }
        });
        if (!r.ok) continue;
        const data = await r.json();
        for (const j of (data.data || [])) {
          const key = (j.job_title + '|' + j.employer_name).toLowerCase();
          if (!seen.has(key)) { seen.add(key); results.push(j); }
        }
      } catch (e) { console.error('JSearch query error:', e.message); }
    }

    return results.map(j => ({
      title: j.job_title || 'Untitled',
      company: j.employer_name || 'Unknown',
      location: j.job_city && j.job_state
        ? `${j.job_city}, ${j.job_state}${j.job_country ? ', ' + j.job_country : ''}`
        : j.job_country || 'Not specified',
      type: j.job_employment_type || 'Full-time',
      is_remote: j.job_is_remote || false,
      url: j.job_apply_link || j.job_google_link || null,
      description: j.job_description || '',
      highlights: j.job_highlights?.Qualifications || [],
      posted: j.job_posted_at_datetime_utc || null,
      salary_min: j.job_min_salary || null,
      salary_max: j.job_max_salary || null,
      salary_currency: j.job_salary_currency || null,
      salary_period: j.job_salary_period || null,
      employer_logo: j.employer_logo || null,
      source: 'jsearch',
      hiring_email: null, tags: [], match: 0, why: ''
    }));
  } catch (err) { console.error('JSearch error:', err.message); return []; }
}

async function fetchAdzuna(query, location) {
  if (!ADZUNA_ID || !ADZUNA_KEY) return [];
  const country = getAdzunaCountry(location);
  if (!country) return [];
  try {
    const params = new URLSearchParams({
      app_id: ADZUNA_ID, app_key: ADZUNA_KEY,
      results_per_page: '15', what: query,
      max_days_old: '30'
    });
    if (location) params.append('where', location);

    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) { console.error('Adzuna error:', r.status); return []; }
    const data = await r.json();
    return (data.results || []).map(j => ({
      title: j.title || 'Untitled',
      company: j.company?.display_name || 'Unknown',
      location: j.location?.display_name || 'Not specified',
      type: j.contract_time === 'part_time' ? 'Part-time' : 'Full-time',
      is_remote: /remote/i.test((j.title || '') + ' ' + (j.description || '')),
      url: j.redirect_url || null,
      description: j.description || '',
      highlights: [],
      posted: j.created || null,
      salary_min: j.salary_min || null,
      salary_max: j.salary_max || null,
      salary_currency: country === 'us' ? 'USD' : country === 'gb' ? 'GBP' : country === 'za' ? 'ZAR' : 'EUR',
      salary_period: j.salary_min ? 'year' : null,
      employer_logo: null,
      source: 'adzuna',
      hiring_email: null, tags: [], match: 0, why: ''
    }));
  } catch (err) { console.error('Adzuna error:', err.message); return []; }
}

async function fetchRemotive(query) {
  try {
    const params = new URLSearchParams({ search: query, limit: '15' });
    const r = await fetch(`https://remotive.com/api/remote-jobs?${params}`);
    if (!r.ok) { console.error('Remotive error:', r.status); return []; }
    const data = await r.json();
    return (data.jobs || []).map(j => ({
      title: j.title || 'Untitled',
      company: j.company_name || 'Unknown',
      location: j.candidate_required_location || 'Remote',
      type: j.job_type || 'Full-time',
      is_remote: true,
      url: j.url || null,
      description: j.description || '',
      highlights: [],
      posted: j.publication_date || null,
      salary_min: j.salary ? parseInt(j.salary) || null : null,
      salary_max: null,
      salary_currency: null,
      salary_period: null,
      employer_logo: j.company_logo || null,
      source: 'remotive',
      hiring_email: null, tags: (j.tags || []), match: 0, why: ''
    }));
  } catch (err) { console.error('Remotive error:', err.message); return []; }
}

router.get('/', async (req, res) => {
  try {
    const { query, location, page = 1, remote_only, date_posted = 'month' } = req.query;
    if (!query) return res.status(400).json({ error: 'query parameter required' });

    const remoteOnly = remote_only === 'true';

    const [jsearchJobs, adzunaJobs, remotiveJobs] = await Promise.all([
      fetchJSearch(query, location, remoteOnly, date_posted),
      fetchAdzuna(query, location),
      fetchRemotive(query)
    ]);

    const seen = new Set();
    const allJobs = [];
    for (const job of [...jsearchJobs, ...adzunaJobs, ...remotiveJobs]) {
      const key = (job.title + '|' + job.company).toLowerCase();
      if (!seen.has(key)) { seen.add(key); allJobs.push(job); }
    }

    console.log(`Jobs API: "${query}" in "${location || 'any'}" → JSearch: ${jsearchJobs.length}, Adzuna: ${adzunaJobs.length}, Remotive: ${remotiveJobs.length}, total: ${allJobs.length}`);
    res.json({ jobs: allJobs, total: allJobs.length });
  } catch (err) {
    console.error('Jobs API error:', err);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

module.exports = router;
