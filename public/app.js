// ─── CONFIG ──────────────────────────────────────────────
// All API calls go through our backend now — no exposed keys
const API_URL = '/api/chat';
const MAX_CHAT_CONTEXT = 20; // only send last 20 messages to LLM

// ─── SESSION ID ─────────────────────────────────────────
function getSessionId() {
  let id = localStorage.getItem('dolk_sessionId');
  if (!id) {
    // Crypto-random 32-char hex — not guessable
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    id = 'sess_' + Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('dolk_sessionId', id);
  }
  return id;
}
const SESSION_ID = getSessionId();

// ─── STATE ───────────────────────────────────────────────
const S = {
  cvText: '', cvName: '', cvData: {},
  cvHasCoverLetter: false, cvCoverLetterText: '',
  jobs: [], appliedJobs: new Set(),
  conversationPhase: 'upload', // upload | chat
  userPrefs: {}, isTyping: false,
  applyIdx: -1, applyStep: 1,
  email: { to: '', subject: '', body: '' },
  existingLetter: false,
  chatHistory: [], // {role, content}
  applications: [], // tracked applications from DB
  emailConfigured: false, // whether SMTP is set up
  emailTemplate: 'professional', // professional | casual | creative
  cvFileStored: false, // whether original CV file is stored on server
  attachCV: true // default: attach CV to application emails
};

// ─── DOM ─────────────────────────────────────────────────
const $msgs = () => document.getElementById('messages');
const $input = document.getElementById('chat-input');
const $bar = document.getElementById('input-bar');
const $uz = document.getElementById('upload-zone');
const $qr = document.getElementById('quick-replies');
const $jl = document.getElementById('jobs-list');
const $jc = document.getElementById('jobs-count');
const $mc = document.getElementById('match-counter');
const $mn = document.getElementById('match-num');
const $prog = document.getElementById('progress');
const $st = document.getElementById('status-text');
const $sd = document.getElementById('status-dot');

// ─── BACKEND API CALL ───────────────────────────────────
async function callAPI(messages, temperature = 0.7, max_tokens = 1024) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, temperature, max_tokens })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || 'API error ' + r.status);
  }
  const d = await r.json();
  return (d.text || '').trim();
}

// Conversation call (with history)
async function groq(userMsg, systemPrompt) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const msg of S.chatHistory.slice(-MAX_CHAT_CONTEXT)) messages.push(msg);
  messages.push({ role: 'user', content: userMsg });
  return callAPI(messages, 0.7, 1024);
}

// Single-shot (no history, for structured tasks)
async function groqOnce(prompt, systemPrompt) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });
  return callAPI(messages, 0.3, 1024);
}

// Combined: detect intent + respond in one call
async function groqChat(userMsg, systemPrompt) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const msg of S.chatHistory.slice(-MAX_CHAT_CONTEXT)) messages.push(msg);
  messages.push({ role: 'user', content: userMsg });
  const text = await callAPI(messages, 0.7, 1024);

  // Parse intent from first line if present
  const lines = text.split('\n');
  let intent = 'GENERAL';
  let response = text;
  if (lines[0].startsWith('[') && lines[0].includes(']')) {
    intent = lines[0].replace(/[\[\]]/g, '').trim();
    response = lines.slice(1).join('\n').trim();
  }
  return { intent, response };
}

// ─── SESSION PERSISTENCE ─────────────────────────────────
async function saveSession() {
  try {
    await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        cvText: S.cvText,
        cvName: S.cvName,
        cvData: S.cvData,
        chatHistory: S.chatHistory,
        jobs: S.jobs,
        appliedJobs: [...S.appliedJobs],
        userPrefs: S.userPrefs
      })
    });
  } catch (err) {
    console.error('Save session failed:', err);
  }
}

async function loadSession() {
  try {
    const r = await fetch('/api/session/' + SESSION_ID);
    const data = await r.json();
    if (!data.found) return false;

    S.cvText = data.cvText || '';
    S.cvName = data.cvName || '';
    S.cvData = data.cvData || {};
    S.chatHistory = data.chatHistory || [];
    S.jobs = data.jobs || [];
    S.appliedJobs = new Set(data.appliedJobs || []);
    S.userPrefs = data.userPrefs || {};

    if (S.cvText) {
      S.conversationPhase = 'chat';
      S.cvHasCoverLetter = !!S.cvData.has_cover_letter;
      S.cvCoverLetterText = S.cvData.cover_letter_text || '';
      // Restore UI
      $uz.style.display = 'none';
      $bar.style.display = 'flex';
      $qr.style.display = 'flex';
      showCVBar(S.cvName, S.cvText.length);
      setStep(S.jobs.length ? 4 : 2);
      setProg(S.jobs.length ? 82 : 30);
      // Replay chat messages
      for (const msg of S.chatHistory) {
        addMsg(msg.role === 'user' ? 'user' : 'ai', msg.content);
      }
      // Replay jobs
      if (S.jobs.length) {
        renderJobs(S.jobs);
        $mc.classList.add('visible');
        $mn.textContent = S.jobs.length;
        $jc.textContent = S.jobs.length + ' found';
      }
      // Applied badges are now rendered automatically by renderJobs() via jobKey
      return true;
    }
    return false;
  } catch (err) {
    console.error('Load session failed:', err);
    return false;
  }
}

// Auto-save on key events (debounced)
let _saveTimer = null;
function debounceSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveSession, 2000);
}

// ─── SYSTEM PROMPT ───────────────────────────────────────
function buildSystemPrompt() {
  const cv = S.cvData || {};
  const cvInfo = [];
  if (cv.name) cvInfo.push(`Name: ${cv.name}`);
  if (cv.current_title) cvInfo.push(`Current role: ${cv.current_title}`);
  if (cv.years_experience) cvInfo.push(`Experience: ${cv.years_experience} years`);
  if (cv.top_skills?.length) cvInfo.push(`Skills: ${cv.top_skills.join(', ')}`);
  if (cv.education) cvInfo.push(`Education: ${cv.education}`);
  if (cv.current_location) cvInfo.push(`Location: ${cv.current_location}`);
  if (cv.languages?.length) cvInfo.push(`Languages: ${cv.languages.join(', ')}`);
  if (cv.email) cvInfo.push(`Email: ${cv.email}`);
  if (cv.summary) cvInfo.push(`Summary: ${cv.summary}`);

  const jobsInfo = S.jobs.length
    ? '\n\nReal jobs found:\n' + S.jobs.map((j, i) => `${i + 1}. ${j.title} at ${j.company} (${j.location}) - ${j.match}% match. ${j.why}${j.url ? ' [Apply: ' + j.url + ']' : ''}`).join('\n')
    : '';

  return `You are Dolk_agent, an AI-powered job application assistant. You have read the user's CV and know them well.

USER'S CV DATA:
${cvInfo.join('\n') || 'CV not yet uploaded.'}
${jobsInfo}

YOUR CAPABILITIES:
- You can search for matching jobs based on their CV and preferences.
- You can generate tailored cover letters in 3 styles: professional, casual, or creative.
${S.emailConfigured
  ? '- You CAN send emails directly on the user\'s behalf (they confirm every step first).\n- You can track sent applications and suggest follow-ups after 7 days.'
  : '- Email sending is not configured yet. You can PREPARE applications but the user must send them via their email client.\n- Tell the user to add their SMTP credentials in the server .env file to enable direct sending.'}
- When a user wants to apply, guide them to click "Apply via email" on any job card in the right panel.

CRITICAL HONESTY RULES — NEVER VIOLATE THESE:
${S.emailConfigured
  ? '- Only say an email was sent if the system confirmed it. If it failed, tell the user honestly.'
  : '- NEVER claim you sent an email. Email sending is not configured. You can only PREPARE them.\n- NEVER say "I applied for you" or "application was sent." The user sends it themselves.'}
- NEVER fabricate actions you didn't take. If you didn't do something, say so.

RESPONSE FORMAT:
Start EVERY response with an intent tag on its own line, then your response. The intent must be one of:
[SEARCH_JOBS] - if the user wants to find/search for jobs
[APPLY] - if the user wants to apply for a job
[GENERAL] - for everything else (questions, CV info, career advice, greetings, etc.)

Example:
[GENERAL]
Your CV shows strong experience in...

CONVERSATION RULES:
- Be conversational and helpful. Answer whatever the user asks.
- If they ask about their CV, summarize what you know from the data above.
- If they ask general questions, answer naturally and accurately.
- Keep responses concise (2-4 sentences) unless they ask for detail.
- Use **bold** for emphasis.
- If jobs haven't been searched yet and the user wants to apply, suggest searching first.`;
}

// ─── FILE HANDLING ───────────────────────────────────────
function handleDrop(e) { e.preventDefault(); document.getElementById('upload-zone').classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }

async function handleFile(f) {
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) { alert('File too large. Max 5MB.'); return; }
  S.cvName = f.name; setStatus('Reading CV…', true);
  try {
    const txt = await readFile(f);
    S.cvText = txt.slice(0, 9000);
    showCVBar(f.name, txt.length);
    $uz.style.display = 'none'; $bar.style.display = 'flex'; $qr.style.display = 'flex';
    setStep(2); setProg(30);
    // Upload the raw file to the server for email attachment
    uploadCVFile(f);
    await analyseCV();
  } catch (e) { setStatus('Error', false); alert('Could not read file. Try saving as .txt.'); }
}

async function uploadCVFile(f) {
  try {
    const buf = await f.arrayBuffer();
    const mimeMap = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.txt': 'text/plain' };
    const ext = f.name.toLowerCase().match(/\.\w+$/)?.[0] || '.pdf';
    const mime = mimeMap[ext] || 'application/octet-stream';
    await fetch('/api/upload-cv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Session-Id': SESSION_ID, 'X-File-Name': f.name, 'X-Mime-Type': mime },
      body: buf
    });
    S.cvFileStored = true;
  } catch (err) { console.error('CV upload failed:', err); S.cvFileStored = false; }
}

async function readFile(f) {
  const name = f.name.toLowerCase();
  if (f.type === 'application/pdf' || name.endsWith('.pdf')) return extractPDF(f);
  if (name.endsWith('.docx') || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return extractDOCX(f);
  return new Promise((ok, fail) => { const r = new FileReader(); r.onload = e => ok(e.target.result); r.onerror = fail; r.readAsText(f); });
}

async function extractDOCX(f) {
  const buf = await f.arrayBuffer();
  const r = await fetch('/api/parse-docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf
  });
  if (!r.ok) throw new Error('DOCX parse failed');
  const data = await r.json();
  return (data.text || '').trim();
}

async function extractPDF(f) {
  if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js not loaded');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf = await f.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let out = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const pg = await pdf.getPage(p);
    const c = await pg.getTextContent();
    out += c.items.map(i => i.str).join(' ') + '\n';
  }
  return out.replace(/\s+/g, ' ').trim();
}

function showCVBar(name, len) {
  document.getElementById('cv-empty').style.display = 'none';
  document.getElementById('cv-file-row').style.display = 'flex';
  document.getElementById('cv-filename').textContent = name;
  document.getElementById('cv-sidebar-sub').textContent = Math.round(len / 1000) + 'k chars · parsed';
  setStepDone(1);
}

// ─── CV ANALYSIS ─────────────────────────────────────────
async function analyseCV() {
  setStatus('Analysing CV…', true);

  const prompt = `Extract structured info from this CV. Return ONLY valid JSON, no markdown fences, no explanation.

CV TEXT:
${S.cvText.slice(0, 5000)}

Return exactly this JSON structure (use null if not found):
{"name":"full name","current_title":"most recent job title","years_experience":"number as string","top_skills":["skill1","skill2","skill3","skill4","skill5"],"education":"highest degree and field","current_location":"city, country","languages":["lang1","lang2"],"email":"email or null","has_cover_letter":false,"cover_letter_text":null,"summary":"2-sentence professional summary"}`;

  let cv = {};
  try {
    const raw = await groqOnce(prompt, 'You are a CV parser. Return only valid JSON. No extra text.');
    const c = raw.replace(/```json|```/g, '').trim();
    const s = c.indexOf('{'), e = c.lastIndexOf('}');
    if (s !== -1 && e !== -1) cv = JSON.parse(c.slice(s, e + 1));
  } catch (err) {
    console.error('CV parse error:', err);
  }

  S.cvData = cv;
  S.cvHasCoverLetter = !!cv.has_cover_letter;
  S.cvCoverLetterText = cv.cover_letter_text || '';
  S.conversationPhase = 'chat';
  setStatus('Ready', false);

  // Build greeting from parsed data
  const parts = [];
  if (cv.name) parts.push(`Hi **${cv.name}**!`);
  else parts.push('Hi!');
  parts.push("I've read your CV thoroughly.");

  const details = [];
  if (cv.current_title) details.push(`you're a **${cv.current_title}**`);
  if (cv.years_experience) details.push(`with **${cv.years_experience} years** of experience`);
  if (cv.top_skills?.length) details.push(`skilled in **${cv.top_skills.slice(0, 3).join(', ')}**`);
  if (details.length) parts.push('I can see ' + details.join(', ') + '.');
  if (cv.summary) parts.push(cv.summary);
  parts.push('\n\nWhat would you like to do? I can **search for jobs**, **write cover letters**, and **prepare applications** for you to send.');

  const greeting = parts.join(' ');
  S.chatHistory.push({ role: 'assistant', content: greeting });
  await aiMsg(greeting, ['Find me jobs', 'Summarize my CV', 'Career advice']);
  debounceSave();
}

// ─── MAIN CHAT HANDLER ──────────────────────────────────
async function sendMessage() {
  const txt = $input.value.trim(); if (!txt || S.isTyping) return;
  $input.value = ''; autoResize($input); showQR([]);
  addMsg('user', txt);
  S.chatHistory.push({ role: 'user', content: txt });

  setStatus('Thinking…', true);
  S.isTyping = true;

  // Handle special commands before hitting the LLM
  const lower = txt.toLowerCase();
  if (lower === 'show my applications' || lower === 'my applications') {
    S.isTyping = false; setStatus('Ready', false);
    await showApplications(); debounceSave(); return;
  }
  if (lower === 'draft follow-ups' || lower === 'send follow-ups') {
    S.isTyping = false; setStatus('Ready', false);
    if (S.emailConfigured && S.applications.length) {
      const pending = S.applications.filter(a => a.status === 'sent' && new Date(a.followUpDate) <= new Date());
      if (pending.length) {
        for (const a of pending) await sendFollowUp(a._id);
      } else {
        await aiMsg("No applications are due for follow-up yet. I'll remind you when it's time!", []);
      }
    } else {
      await aiMsg(S.emailConfigured ? "No applications to follow up on yet." : "Email sending isn't configured. Add SMTP credentials to .env to enable this.", []);
    }
    debounceSave(); return;
  }
  if (lower === 'dismiss') {
    S.isTyping = false; setStatus('Ready', false);
    await aiMsg("Got it, reminders dismissed. Let me know if you need anything!", ['Find me jobs', 'Show my applications']);
    debounceSave(); return;
  }

  try {
    // Single API call: intent detection + response combined
    const { intent, response } = await groqChat(txt, buildSystemPrompt());

    if (intent === 'SEARCH_JOBS') {
      // Don't show LLM response — it may fabricate job titles. Let real search speak.
      const searchNote = `Searching for real jobs based on your request...`;
      S.chatHistory.push({ role: 'assistant', content: searchNote });
      await aiMsg(searchNote, []);
      await handleJobSearch(txt);
    } else if (intent === 'APPLY') {
      S.chatHistory.push({ role: 'assistant', content: response });
      setStatus('Ready', false);
      await aiMsg(response, S.jobs.length ? [] : ['Find me jobs']);
    } else {
      S.chatHistory.push({ role: 'assistant', content: response });
      setStatus('Ready', false);
      const suggestions = S.jobs.length
        ? ['Apply to top match', 'Search more jobs']
        : ['Find me jobs', 'Summarize my CV', 'Career advice'];
      await aiMsg(response, suggestions);
    }
  } catch (err) {
    console.error('Chat error:', err);
    setStatus('Ready', false);
    const errMsg = err.message.includes('API') ? 'API error: ' + err.message : 'Something went wrong. Try again.';
    await aiMsg(errMsg, []);
  }

  S.isTyping = false;
  debounceSave();
}

// ─── JOB SEARCH ─────────────────────────────────────────
async function handleJobSearch(msg) {
  // Always re-parse prefs from the latest message — user may refine their search
  await gatherPrefsFromMessage(msg);

  setStatus('Searching…', true);
  $sd.style.background = '#fbbf24'; $sd.style.boxShadow = '0 0 6px #fbbf24';
  setStep(3); setProg(55);

  await searchJobs();
}

async function gatherPrefsFromMessage(msg) {
  const cv = S.cvData || {};
  // Include recent chat history so the LLM understands context like "ok try in rwanda"
  const recentChat = S.chatHistory.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
  const prevRole = S.userPrefs.role || '';
  const prevLocation = S.userPrefs.location || '';

  try {
    const raw = await groqOnce(`Extract job search preferences from the conversation. Return ONLY JSON, no other text.

RECENT CONVERSATION:
${recentChat}

LATEST USER MESSAGE: "${msg}"

PREVIOUS SEARCH (if any): role="${prevRole}", location="${prevLocation}"
CV title: ${cv.current_title || 'unknown'}
CV location: ${cv.current_location || 'unknown'}

RULES:
- If the user specifies a role/industry, use THAT (e.g. "hospitality", "tourism", "developer").
- If the user only changes location (e.g. "ok try in rwanda"), KEEP the previous role and update the location.
- If the user only changes role, KEEP the previous location.
- Make the role a short, searchable term (1-3 words max). NOT a long CV title.
- Location must be a real place name, not "none" or "not specified".

Return: {"role":"searchable role","location":"location or remote","seniority":"level"}`,
      'Return only valid JSON. No explanation.');
    const c = raw.replace(/```json|```/g, '').trim();
    const s = c.indexOf('{'), e = c.lastIndexOf('}');
    if (s !== -1 && e !== -1) {
      const prefs = JSON.parse(c.slice(s, e + 1));
      S.userPrefs = {
        role: prefs.role || prevRole || cv.current_title || 'any role',
        location: prefs.location || prevLocation || cv.current_location || 'remote',
        seniority: prefs.seniority || inferLevel(cv.years_experience || '3'),
        skills: (cv.top_skills || []).join(', '),
        education: cv.education || '', other: ''
      };
      return;
    }
  } catch {}
  S.userPrefs = {
    role: prevRole || cv.current_title || 'any role',
    location: prevLocation || cv.current_location || 'remote',
    seniority: cv.years_experience ? inferLevel(cv.years_experience) : 'mid-level',
    skills: (cv.top_skills || []).join(', '),
    education: cv.education || '', other: ''
  };
}

function inferLevel(y) { const n = parseFloat(y); if (n < 2) return 'entry level'; if (n < 5) return 'mid-level'; if (n < 9) return 'senior'; return 'lead / principal'; }

async function fetchJobs(query, location, remoteOnly, datePosted = 'week') {
  const params = new URLSearchParams({ query, date_posted: datePosted });
  if (location && !remoteOnly) params.append('location', location);
  if (remoteOnly) params.append('remote_only', 'true');
  const r = await fetch('/api/jobs?' + params);
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || 'Job search failed');
  }
  const data = await r.json();
  let jobs = data.jobs || [];
  // If weekly search returns nothing, try monthly for more results
  if (jobs.length === 0 && datePosted === 'week') {
    return fetchJobs(query, location, remoteOnly, 'month');
  }
  return jobs;
}

async function searchJobs() {
  try {
    const cv = S.cvData || {};
    const prefs = S.userPrefs;
    const role = prefs.role || cv.current_title || 'developer';
    const location = prefs.location || cv.current_location || '';
    const isRemote = /remote/i.test(location);

    // Step 1: Fetch real jobs — with honest fallback
    let jobs = [];
    let searchNote = '';
    let searchedLocation = location;

    if (isRemote) {
      jobs = await fetchJobs(role, '', true);
      searchedLocation = 'Remote';
    } else {
      // Try exact location first (e.g. "Kigali")
      if (location) jobs = await fetchJobs(role, location, false);

      // Fallback 1: try country only (e.g. "Rwanda" from "Kigali, Rwanda")
      if (jobs.length === 0 && location) {
        const country = location.split(',').pop().trim();
        if (country && country !== location) {
          jobs = await fetchJobs(role, country, false);
          if (jobs.length > 0) {
            searchNote = `No **${role}** jobs found in **${location}** specifically — showing results for **${country}**.`;
            searchedLocation = country;
          }
        }
      }

      // If still nothing, DON'T silently go global. Ask user what they want.
      if (jobs.length === 0) {
        setStatus('Ready', false);
        await aiMsg(`No **${role}** jobs found in **${location}**. This region may have limited online listings.\n\nI can:\n- **Search worldwide** for ${role} jobs (including remote)\n- **Try a different role** — e.g. "hospitality", "hotel", "customer service"\n\nWhat would you prefer?`, ['Search worldwide', 'Search remote only', 'Try different role']);
        return;
      }
    }

    if (searchNote) await aiMsg(searchNote, []);

    // Step 2: LLM scores real jobs against CV
    const jobSummaries = jobs.slice(0, 10).map((j, i) =>
      `${i + 1}. ${j.title} at ${j.company} (${j.location}) — ${(j.description || '').slice(0, 200)}`
    ).join('\n');

    let scored = [];
    try {
      const scorePrompt = `Score how well each job matches this candidate. Return ONLY a JSON array.

CANDIDATE: ${cv.name || 'N/A'}, ${cv.current_title || 'professional'}, ${cv.years_experience || '?'} yrs exp.
SKILLS: ${(cv.top_skills || []).join(', ') || 'general'}
EDUCATION: ${cv.education || 'N/A'}
LOOKING FOR: ${role}, ${prefs.seniority || 'mid-level'} level

JOBS:
${jobSummaries}

Return: [{"index":1,"match":85,"tags":["skill1","skill2"],"why":"One sentence why this matches"}]
Score 0-100. Be honest — low match if skills don't align. Include 3-5 relevant skill tags per job.`;

      const scoreResp = await groqOnce(scorePrompt, 'Return only a valid JSON array. No markdown. No explanation.');
      scored = parseJSON(scoreResp);
    } catch (e) {
      console.error('Scoring error:', e);
    }

    // Merge scores into jobs
    jobs = jobs.slice(0, 10).map((job, i) => {
      const s = scored.find(x => x.index === i + 1) || {};
      return {
        ...job,
        match: s.match || 50,
        tags: s.tags || (cv.top_skills || []).slice(0, 3),
        why: s.why || 'Potential match based on your profile.'
      };
    });

    // Sort by match score descending
    jobs.sort((a, b) => b.match - a.match);

    S.jobs = jobs; renderJobs(jobs);
    setStep(4); setProg(82); setStatus('Done', false);
    $sd.style.background = 'var(--green)'; $sd.style.boxShadow = '0 0 6px var(--green)';
    $mc.classList.add('visible'); $mn.textContent = jobs.length; $jc.textContent = jobs.length + ' found';

    const topJob = jobs[0];
    const resultMsg = `I found **${jobs.length} real jobs** matching your profile! Top match: **${topJob.title}** at **${topJob.company}** (${topJob.match}% match).\n\nCheck the panel on the right. Click **View posting** to see the full listing, or **Apply via email** to prepare an application.`;
    S.chatHistory.push({ role: 'assistant', content: resultMsg });
    await aiMsg(resultMsg, ['Tell me about the top match', 'Apply to the best one']);
    debounceSave();
  } catch (err) {
    setStatus('Error', false);
    console.error('Search error:', err);
    await aiMsg('Search hit an error: ' + err.message, ['Try again']);
  }
}

// ─── APPLY MODAL ─────────────────────────────────────────
async function startApply(idx) {
  const job = S.jobs[idx];
  if (!job || S.appliedJobs.has(jobKey(job))) return;
  S.applyIdx = idx; S.applyStep = 1;
  document.getElementById('modal-title').textContent = `Applying: ${job.title}`;
  document.getElementById('modal-sub').textContent = `${job.company} · You approve every step`;
  document.getElementById('modal-overlay').classList.add('open');
  await renderStep1(job);
}

async function renderStep1(job) {
  setMStep(1);
  const $b = document.getElementById('modal-body');
  const hasExisting = S.cvHasCoverLetter && S.cvCoverLetterText && S.cvCoverLetterText.length > 60;
  S.existingLetter = hasExisting;
  const emailKnown = job.hiring_email && job.hiring_email !== 'null' && job.hiring_email !== null;

  $b.innerHTML = `
    <div class="mlabel">Step 1 — application target</div>
    ${hasExisting
      ? `<div class="smart-banner"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-top:1px;"><circle cx="8" cy="8" r="6" stroke="#a99ef9" stroke-width="1.2"/><path d="M5.5 8.5L7 10L10.5 6" stroke="#4ade80" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="smart-banner-text"><strong>Cover letter found in your CV.</strong> It will be used as-is.</div></div>`
      : `<div class="info-box">I'll generate a personalised cover letter for this role in the next step.</div>`}
    <div class="mlabel" style="margin-top:4px;">Details</div>
    <div class="email-preview">
      <div class="ef"><span class="efl">Role</span><span class="efv">${esc(job.title)} at ${esc(job.company)}</span></div>
      <div class="ef"><span class="efl">Method</span><span class="efv">Email application</span></div>
    </div>
    <div class="mlabel" style="margin-top:4px;">${emailKnown ? 'Hiring email (editable)' : 'Enter hiring email'}</div>
    <input class="mini-input" id="manual-email" type="email" placeholder="hiring@company.com" value="${emailKnown ? esc(job.hiring_email) : ''}" oninput="document.getElementById('main-action-btn').disabled=!this.value.includes('@')"/>
    ${!hasExisting ? `
    <div class="mlabel" style="margin-top:8px;">Cover letter style</div>
    <div style="display:flex;gap:6px;">
      <button class="template-btn${S.emailTemplate === 'professional' ? ' active' : ''}" onclick="pickTemplate('professional',this)">Professional</button>
      <button class="template-btn${S.emailTemplate === 'casual' ? ' active' : ''}" onclick="pickTemplate('casual',this)">Casual</button>
      <button class="template-btn${S.emailTemplate === 'creative' ? ' active' : ''}" onclick="pickTemplate('creative',this)">Creative</button>
    </div>` : ''}
    ${S.cvFileStored ? `
    <div class="mlabel" style="margin-top:8px;">Attachment</div>
    <div class="confirm-row">
      <input type="checkbox" id="attach-cv-check" ${S.attachCV ? 'checked' : ''} onchange="S.attachCV=this.checked"/>
      <label for="attach-cv-check">Attach my CV (<strong>${esc(S.cvName)}</strong>) to this email</label>
    </div>` : `
    <div class="mlabel" style="margin-top:8px;">Attachment</div>
    <div class="warn-box" style="font-size:11px;">CV file not available for attachment. Re-upload your CV to enable this.</div>`}
  `;
  const $btn = document.getElementById('main-action-btn');
  $btn.textContent = 'Continue →'; $btn.disabled = !emailKnown;
  $btn.onclick = () => runStep2();
}

async function runStep2() {
  const job = S.jobs[S.applyIdx];
  const emailTo = (document.getElementById('manual-email')?.value || '').trim();
  if (!emailTo || !emailTo.includes('@')) { alert('Please provide a valid hiring email.'); return; }
  S.email.to = emailTo;

  setMStep(2);
  const $b = document.getElementById('modal-body');
  const $btn = document.getElementById('main-action-btn');
  $b.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);font-size:13px;"><span class="spinner"></span>${S.existingLetter ? 'Loading your cover letter…' : 'Writing tailored cover letter…'}</div>`;
  $btn.disabled = true; $btn.textContent = 'Continue →'; $btn.onclick = () => runStep3();

  const cv = S.cvData || {};
  let body, subject;

  if (S.existingLetter) {
    body = S.cvCoverLetterText.trim();
    subject = `Application for ${job.title} – ${cv.name || 'Applicant'}`;
  } else {
    const toneInstructions = {
      professional: 'Write in a formal, professional tone. Use proper business language. Strong opening, reference 2-3 specific skills, clear call to action.',
      casual: 'Write in a warm, conversational tone. Still professional but more personable and approachable. Show genuine enthusiasm for the role. Use first-person naturally.',
      creative: 'Write in a bold, memorable tone. Open with a hook that grabs attention. Show personality while staying relevant. Make it stand out from generic applications.'
    };
    const tone = toneInstructions[S.emailTemplate] || toneInstructions.professional;

    try {
      body = await groqOnce(`Write a job application email body for ${cv.name || 'the candidate'} applying to ${job.title} at ${job.company}.

Candidate: ${cv.current_title || 'professional'}, ${cv.years_experience || 'several'} years experience.
Skills: ${(cv.top_skills || []).join(', ')}
Education: ${cv.education || 'Not specified'}
Role: ${job.title} at ${job.company} (${job.location}).
Why good fit: ${job.why || 'strong skill match'}

TONE: ${tone}

Write 150-220 words. No "Dear Hiring Manager" header. No placeholders like [Company]. Return ONLY the email body text.`,
        'You are a cover letter writer. Return only the email body text, nothing else.');
    } catch {
      body = `I am writing to express my strong interest in the ${job.title} position at ${job.company}. With my experience in ${(cv.top_skills || ['relevant skills']).slice(0, 2).join(' and ')}, I believe I would be a strong addition to your team.`;
    }
    subject = `Application for ${job.title} – ${cv.name || 'Applicant'}`;
  }

  S.email = { to: emailTo, subject, body };

  $b.innerHTML = `
    <div class="mlabel">Step 2 — email preview</div>
    ${S.existingLetter
      ? `<div class="smart-banner" style="margin-bottom:8px;"><div class="smart-banner-text"><strong>Using your existing cover letter</strong> — nothing changed.</div></div>`
      : `<div class="info-box" style="margin-bottom:8px;">Generated for this role. Review carefully before continuing.</div>`}
    <div class="email-preview">
      <div class="ef"><span class="efl">To</span><span class="efv">${esc(emailTo)}</span></div>
      <div class="ef"><span class="efl">Subject</span><span class="efv">${esc(subject)}</span></div>
      <div class="ediv"></div>
      <div class="ebody">${esc(body)}</div>
    </div>
  `;
  $btn.disabled = false;
}

function runStep3() {
  setMStep(3);
  const $b = document.getElementById('modal-body');
  const $btn = document.getElementById('main-action-btn');
  const e = S.email;
  $b.innerHTML = `
    <div class="mlabel">Step 3 — edit before sending</div>
    <div class="ef" style="margin-bottom:6px;"><span class="efl">To</span><input class="mini-input" id="e-to" type="email" value="${esc(e.to)}" style="flex:1;"/></div>
    <div class="ef" style="margin-bottom:10px;"><span class="efl">Subject</span><input class="mini-input" id="e-sub" type="text" value="${esc(e.subject)}" style="flex:1;"/></div>
    <div class="mlabel">Email body</div>
    <textarea class="edit-area" id="e-body">${esc(e.body)}</textarea>
    <div class="info-box">Edit anything above. Next step is final confirmation.</div>
  `;
  $btn.disabled = false; $btn.textContent = 'Continue →'; $btn.onclick = () => runStep4();
}

function runStep4() {
  S.email.to = (document.getElementById('e-to').value || '').trim();
  S.email.subject = (document.getElementById('e-sub').value || '').trim();
  S.email.body = (document.getElementById('e-body').value || '').trim();
  if (!S.email.to.includes('@')) { alert('Please enter a valid email.'); return; }

  setMStep(4);
  const $b = document.getElementById('modal-body');
  const $f = document.getElementById('modal-footer');
  const job = S.jobs[S.applyIdx];
  const e = S.email;

  $b.innerHTML = `
    <div class="mlabel">Step 4 — final confirmation</div>
    <div class="info-box" style="margin-bottom:10px;">${S.emailConfigured ? 'Review your application below. After confirming, it will be <strong>sent directly</strong> to the employer.' : 'Review your application below. After confirming, you\'ll be able to <strong>open it in your email client</strong> or <strong>copy it</strong> to send manually.'}</div>
    <div class="email-preview">
      <div class="ef"><span class="efl">To</span><span class="efv">${esc(e.to)}</span></div>
      <div class="ef"><span class="efl">Subject</span><span class="efv">${esc(e.subject)}</span></div>
      ${(S.attachCV && S.cvFileStored) ? `<div class="ef"><span class="efl">Attach</span><span class="efv">📎 ${esc(S.cvName)}</span></div>` : ''}
      <div class="ediv"></div>
      <div class="ebody" style="max-height:110px;">${esc(e.body).replace(/\n/g, '<br/>')}</div>
    </div>
    <div class="mlabel" style="margin-top:4px;">Tick all to continue</div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      <div class="confirm-row"><input type="checkbox" id="ck1" onchange="chkSend()"/><label for="ck1">I have read this email and it represents me accurately.</label></div>
      <div class="confirm-row"><input type="checkbox" id="ck2" onchange="chkSend()"/><label for="ck2">I want to apply for <strong>${esc(job.title)}</strong> at <strong>${esc(job.company)}</strong>.</label></div>
      <div class="confirm-row"><input type="checkbox" id="ck3" onchange="chkSend()"/><label for="ck3">${S.emailConfigured ? 'I authorize Dolk Agent to send this email on my behalf.' : 'I understand I will send this email myself via my email client.'}</label></div>
    </div>
  `;
  $f.innerHTML = `
    <button class="btn-cancel" onclick="runStep3()">← Back &amp; edit</button>
    <button class="btn-send" id="send-btn" onclick="runStep5()" disabled>${S.emailConfigured ? 'Send Application →' : 'Prepare Application →'}</button>
  `;
}

function chkSend() {
  const ok = ['ck1', 'ck2', 'ck3'].every(id => document.getElementById(id)?.checked);
  const b = document.getElementById('send-btn'); if (b) b.disabled = !ok;
}

async function runStep5() {
  setMStep(5);
  const $b = document.getElementById('modal-body');
  const $f = document.getElementById('modal-footer');
  $f.innerHTML = '';
  const job = S.jobs[S.applyIdx];

  if (S.emailConfigured) {
    // ─── SEND VIA BACKEND ───────────────────────────────
    $b.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);font-size:13px;"><span class="spinner"></span> Sending your application…</div>`;
    try {
      const r = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          emailTo: S.email.to,
          subject: S.email.subject,
          body: S.email.body,
          jobTitle: job.title,
          company: job.company,
          location: job.location || '',
          jobUrl: job.url || '',
          matchScore: job.match || 0,
          attachCV: S.attachCV && S.cvFileStored
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Send failed');

      // Success!
      const followDate = new Date(data.followUpDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const didAttach = S.attachCV && S.cvFileStored;
      $b.innerHTML = `
        <div class="ok-box" style="text-align:center;padding:20px;">
          <div style="font-size:26px;margin-bottom:8px;">✅</div>
          <div style="font-size:14px;font-weight:600;color:var(--green);margin-bottom:4px;">Application sent!</div>
          <div style="font-size:12px;color:var(--text2);">To <strong>${esc(S.email.to)}</strong> for <strong>${esc(job.title)}</strong> at <strong>${esc(job.company)}</strong></div>
          ${didAttach ? `<div style="font-size:11px;color:var(--accent2);margin-top:4px;">📎 CV attached: ${esc(S.cvName)}</div>` : ''}
        </div>
        <div class="info-box" style="margin-top:8px;">I'll remind you to follow up on <strong>${followDate}</strong> if you haven't heard back.</div>
        <div class="email-preview" style="margin-top:8px;">
          <div class="ef"><span class="efl">To</span><span class="efv">${esc(S.email.to)}</span></div>
          <div class="ef"><span class="efl">Subject</span><span class="efv">${esc(S.email.subject)}</span></div>
          ${didAttach ? `<div class="ef"><span class="efl">Attach</span><span class="efv">📎 ${esc(S.cvName)}</span></div>` : ''}
          <div class="ediv"></div>
          <div class="ebody" style="max-height:100px;">${esc(S.email.body).replace(/\n/g, '<br/>')}</div>
        </div>
      `;
      $f.innerHTML = `<button class="btn-cancel" onclick="closeModal()">Close</button>`;
      markApplied(S.applyIdx); addToSidebar(job);

      const attachNote = didAttach ? ' Your CV was attached.' : '';
      const doneMsg = `Your application for **${job.title}** at **${job.company}** has been **sent** to ${S.email.to}!${attachNote} I'll remind you to follow up on **${followDate}** if there's no reply. Want to apply to another job?`;
      S.chatHistory.push({ role: 'assistant', content: doneMsg });
      await aiMsg(doneMsg, ['Apply to next job', 'Search more jobs', 'Show my applications']);
      await loadApplications();
      debounceSave();
    } catch (err) {
      console.error('Send email error:', err);
      $b.innerHTML = `
        <div class="warn-box" style="text-align:center;padding:16px;">
          <div style="font-size:22px;margin-bottom:6px;">⚠</div>
          <div style="font-size:13px;font-weight:600;color:var(--amber);margin-bottom:4px;">Failed to send</div>
          <div style="font-size:12px;color:var(--text2);">${esc(err.message)}</div>
        </div>
        ${buildMailtoFallback(job)}
      `;
      $f.innerHTML = `<button class="btn-cancel" onclick="closeModal()">Close</button><button class="btn-next" onclick="copyEmail()">Copy email</button>`;
    }
  } else {
    // ─── NO SMTP — MAILTO FALLBACK ──────────────────────
    const mailtoLink = `mailto:${encodeURIComponent(S.email.to)}?subject=${encodeURIComponent(S.email.subject)}&body=${encodeURIComponent(S.email.body)}`;
    $b.innerHTML = `
      <div class="ok-box" style="text-align:center;padding:20px;">
        <div style="font-size:26px;margin-bottom:8px;">✅</div>
        <div style="font-size:14px;font-weight:600;color:var(--green);margin-bottom:4px;">Application prepared!</div>
        <div style="font-size:12px;color:var(--text2);">For <strong>${esc(job.title)}</strong> at <strong>${esc(job.company)}</strong></div>
      </div>
      <div class="warn-box" style="margin-top:8px;font-size:11px;">Direct email sending is not configured. You can send manually below, or add SMTP credentials to enable auto-send.</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
        <a href="${mailtoLink}" target="_blank" class="btn-send" style="text-decoration:none;text-align:center;display:block;padding:11px 16px;border-radius:var(--radius-sm);">Open in email client →</a>
        <div style="text-align:center;font-size:11px;color:var(--text3);">or</div>
      </div>
      <div class="info-box">You can also copy the email below and paste it manually.</div>
      <div class="email-preview" style="margin-top:4px;">
        <div class="ef"><span class="efl">To</span><span class="efv">${esc(S.email.to)}</span></div>
        <div class="ef"><span class="efl">Subject</span><span class="efv">${esc(S.email.subject)}</span></div>
        <div class="ediv"></div>
        <div class="ebody">${esc(S.email.body)}</div>
      </div>
    `;
    $f.innerHTML = `<button class="btn-cancel" onclick="closeModal()">Close</button><button class="btn-next" onclick="copyEmail()">Copy email</button>`;
    markApplied(S.applyIdx); addToSidebar(job);

    const doneMsg = `Your application for **${job.title}** at **${job.company}** is prepared! Click **"Open in email client"** or **copy the email** and send it yourself. Want me to prepare another application?`;
    S.chatHistory.push({ role: 'assistant', content: doneMsg });
    await aiMsg(doneMsg, ['Apply to next job', 'Search more jobs']);
    debounceSave();
  }
}

function buildMailtoFallback(job) {
  const mailtoLink = `mailto:${encodeURIComponent(S.email.to)}?subject=${encodeURIComponent(S.email.subject)}&body=${encodeURIComponent(S.email.body)}`;
  return `
    <div class="info-box" style="margin-top:8px;">You can still send it manually:</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
      <a href="${mailtoLink}" target="_blank" class="btn-send" style="text-decoration:none;text-align:center;display:block;padding:11px 16px;border-radius:var(--radius-sm);">Open in email client →</a>
    </div>
  `;
}

function copyEmail() {
  navigator.clipboard.writeText(`To: ${S.email.to}\nSubject: ${S.email.subject}\n\n${S.email.body}`);
  const b = document.querySelector('#modal-footer .btn-next'); if (b) { b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Copy email', 2000); }
}

// ─── MODAL HELPERS ────────────────────────────────────────
function setMStep(n) {
  [1, 2, 3, 4, 5].forEach(i => {
    const s = document.getElementById('mstep-' + i), d = document.getElementById('msdot-' + i);
    if (i < n) { s.className = 'mstep done'; d.textContent = '✓'; }
    else if (i === n) { s.className = 'mstep active'; d.textContent = i; }
    else { s.className = 'mstep'; d.textContent = i; }
  });
  S.applyStep = n;
  if (n < 4) {
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-next" id="main-action-btn">Continue →</button>
    `;
  }
}
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }

// ─── MESSAGES UI ─────────────────────────────────────────
function addMsg(role, txt) {
  const g = document.createElement('div'); g.className = 'msg-group' + (role === 'user' ? ' user' : '');
  const s = document.createElement('div'); s.className = 'msg-sender'; s.textContent = role === 'user' ? 'You' : 'Dolk_agent';
  const b = document.createElement('div'); b.className = 'msg-bubble ' + role; b.innerHTML = fmt(txt);
  g.appendChild(s); g.appendChild(b); $msgs().appendChild(g); scroll(); return b;
}
function fmt(t) {
  // Escape HTML first, then apply safe markdown formatting
  const safe = esc(t);
  return safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>');
}
function showTyping() { const g = document.createElement('div'); g.className = 'msg-group'; g.id = 'typing'; const s = document.createElement('div'); s.className = 'msg-sender'; s.textContent = 'Dolk_agent'; const b = document.createElement('div'); b.className = 'typing'; b.innerHTML = '<span></span><span></span><span></span>'; g.appendChild(s); g.appendChild(b); $msgs().appendChild(g); scroll(); }
function hideTyping() { const t = document.getElementById('typing'); if (t) t.remove(); }
async function aiMsg(txt, qr = []) {
  S.isTyping = true; showTyping(); await sleep(300); hideTyping(); addMsg('ai', txt);
  if (qr.length) showQR(qr); S.isTyping = false;
}
function showQR(opts) { $qr.innerHTML = ''; if (!opts || !opts.length) { $qr.style.display = 'none'; return; } $qr.style.display = 'flex'; opts.forEach(o => { const b = document.createElement('button'); b.className = 'quick-reply'; b.textContent = o; b.onclick = () => { $input.value = o; sendMessage(); }; $qr.appendChild(b); }); }

// ─── JOBS UI ─────────────────────────────────────────────
function renderJobs(jobs) {
  $jl.innerHTML = '';
  jobs.forEach((job, i) => {
    const card = document.createElement('div'); card.className = 'job-card'; card.id = 'jc-' + i; card.style.animationDelay = (i * 80) + 'ms';
    const isApplied = S.appliedJobs.has(jobKey(job));
    const mc = job.match >= 85 ? 'match-high' : job.match >= 70 ? 'match-mid' : 'match-low';
    const tags = (job.tags || []).map(t => `<span class="job-tag">${esc(t)}</span>`).join('');
    const remote = job.is_remote ? '<span class="job-tag" style="border-color:rgba(74,222,128,.3);color:var(--green);">Remote</span>' : '';
    const salary = job.salary_min && job.salary_max
      ? `<div class="job-salary">${esc(job.salary_currency || '$')}${job.salary_min.toLocaleString()} – ${job.salary_max.toLocaleString()} / ${esc(job.salary_period || 'year')}</div>`
      : '';
    const viewBtn = job.url
      ? `<a href="${esc(job.url)}" target="_blank" rel="noopener" class="job-btn job-btn-view">View posting</a>`
      : '';
    card.innerHTML = `
      <div class="job-card-top">
        ${job.employer_logo ? `<img src="${esc(job.employer_logo)}" class="job-logo" alt="" onerror="this.style.display='none'"/>` : ''}
        <div style="flex:1;min-width:0;"><div class="job-title">${esc(job.title)}</div><div class="job-company">${esc(job.company)} · ${esc(job.location)}</div>${salary}</div>
        <div class="job-match ${mc}">${parseInt(job.match) || 0}%</div>
      </div>
      ${tags || remote ? `<div class="job-tags">${remote}${tags}</div>` : ''}
      <div class="job-why">${esc(job.why || '')}</div>
      <div class="job-actions">
        <button class="job-btn job-btn-primary" id="abtn-${i}" onclick="startApply(${i})"${isApplied ? ' disabled' : ''}>${isApplied ? 'Applied' : 'Apply via email'}</button>
        ${viewBtn}
        <button class="job-btn job-btn-secondary" onclick="askAbout(${i})">Ask agent</button>
      </div>
      <div id="abadge-${i}" style="display:${isApplied ? 'block' : 'none'};"><div class="applied-badge"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5.5L3.5 7.5L8.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Applied</div></div>
    `;
    $jl.appendChild(card);
  });
}

function markApplied(idx) {
  const job = S.jobs[idx];
  if (job) S.appliedJobs.add(jobKey(job));
  const b = document.getElementById('abadge-' + idx); if (b) b.style.display = 'block';
  const btn = document.getElementById('abtn-' + idx); if (btn) { btn.textContent = 'Applied'; btn.disabled = true; }
}

function addToSidebar(job) {
  document.getElementById('applied-tracker').classList.add('visible');
  const item = document.createElement('div'); item.className = 'applied-item';
  item.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5.5L3.5 7.5L8.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>${esc(job.title)} @ ${esc(job.company)}`;
  document.getElementById('applied-list').appendChild(item);
}

function askAbout(idx) { const j = S.jobs[idx]; if (!j) return; $input.value = `Tell me more about the ${j.title} role at ${j.company}.`; $input.focus(); }

// ─── HELPERS ─────────────────────────────────────────────
function parseJSON(raw) { try { const c = raw.replace(/```json|```/g, '').trim(); const s = c.indexOf('['), e = c.lastIndexOf(']'); if (s === -1 || e === -1) return []; return JSON.parse(c.slice(s, e + 1)); } catch { return []; } }
function jobKey(job) { return (job.title + '|' + job.company).toLowerCase(); }
function setStep(n) { [1, 2, 3, 4].forEach(i => { const el = document.getElementById('step-' + i), num = document.getElementById('step-num-' + i); el.className = 'step' + (i < n ? ' done' : i === n ? ' active' : ''); num.textContent = i < n ? '✓' : i; }); }
function setStepDone(n) { document.getElementById('step-' + n).className = 'step done'; document.getElementById('step-num-' + n).textContent = '✓'; }
function setProg(p) { $prog.style.width = p + '%'; }
function setStatus(txt, loading) { $st.textContent = txt; $sd.style.animation = loading ? 'pulse 1.5s infinite' : 'none'; if (!loading) { $sd.style.background = 'var(--green)'; $sd.style.boxShadow = '0 0 6px var(--green)'; } }
function scroll() { setTimeout(() => { const m = $msgs(); m.scrollTop = m.scrollHeight; }, 50); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
function handleKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function toggleSidebar() { const s = document.getElementById('sidebar'); s.classList.toggle('open'); document.getElementById('overlay').style.display = s.classList.contains('open') ? 'block' : 'none'; }
function closeMobile() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('overlay').style.display = 'none'; }

// ─── TEMPLATE PICKER ─────────────────────────────────────
function pickTemplate(name, el) {
  S.emailTemplate = name;
  document.querySelectorAll('.template-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}

// ─── APPLICATION TRACKING ────────────────────────────────
async function loadApplications() {
  try {
    const r = await fetch('/api/applications/' + SESSION_ID);
    const data = await r.json();
    S.applications = data.applications || [];
  } catch (err) { console.error('Load applications error:', err); }
}

async function checkFollowUps() {
  try {
    const r = await fetch('/api/follow-ups/' + SESSION_ID);
    const data = await r.json();
    const reminders = data.reminders || [];
    if (reminders.length > 0) {
      const names = reminders.map(a => `**${a.jobTitle}** at **${a.company}**`);
      const reminderMsg = reminders.length === 1
        ? `Reminder: You applied for ${names[0]} over a week ago with no reply. Would you like me to draft a follow-up email?`
        : `Reminder: You have **${reminders.length} applications** with no reply after 7+ days:\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nWould you like me to draft follow-up emails?`;
      S.chatHistory.push({ role: 'assistant', content: reminderMsg });
      await aiMsg(reminderMsg, ['Draft follow-ups', 'Dismiss']);
    }
  } catch (err) { console.error('Follow-up check error:', err); }
}

async function sendFollowUp(applicationId) {
  const app = S.applications.find(a => a._id === applicationId);
  if (!app) return;

  const cv = S.cvData || {};
  try {
    const body = await groqOnce(`Write a brief, polite follow-up email for a job application.

Original application was for: ${app.jobTitle} at ${app.company}
Sent on: ${new Date(app.sentAt).toLocaleDateString()}
Candidate: ${cv.name || 'the candidate'}, ${cv.current_title || 'professional'}

Write 60-100 words. Reference the original application. Express continued interest. Ask about timeline. Professional but warm. Return ONLY the email body text.`,
      'Return only the email body text.');

    const subject = `Following up: ${app.subject}`;

    const r = await fetch('/api/send-followup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId, subject, body })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');

    await loadApplications();
    const doneMsg = `Follow-up sent to **${app.emailTo}** for the **${app.jobTitle}** role at **${app.company}**!`;
    S.chatHistory.push({ role: 'assistant', content: doneMsg });
    await aiMsg(doneMsg, ['Show my applications']);
    debounceSave();
  } catch (err) {
    await aiMsg(`Failed to send follow-up: ${err.message}`, []);
  }
}

async function showApplications() {
  await loadApplications();
  if (S.applications.length === 0) {
    await aiMsg("You haven't sent any applications yet. Find jobs and apply to get started!", ['Find me jobs']);
    return;
  }
  const statusIcon = { sent: '📨', followed_up: '🔄', replied: '💬', rejected: '❌', offered: '🎉' };
  const lines = S.applications.map((a, i) => {
    const icon = statusIcon[a.status] || '📨';
    const date = new Date(a.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${i + 1}. ${icon} **${a.jobTitle}** at **${a.company}** — ${a.status} (${date})`;
  });
  const msg = `Your applications (${S.applications.length}):\n\n${lines.join('\n')}`;
  S.chatHistory.push({ role: 'assistant', content: msg });
  await aiMsg(msg, ['Draft follow-ups', 'Search more jobs']);
}

// ─── CHECK EMAIL CONFIG ON LOAD ──────────────────────────
async function checkEmailConfig() {
  try {
    const r = await fetch('/api/email-status');
    const data = await r.json();
    S.emailConfigured = data.configured;
  } catch { S.emailConfigured = false; }
}

// ─── INIT: LOAD SESSION ON PAGE LOAD ─────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await checkEmailConfig();
  const restored = await loadSession();
  if (restored && S.emailConfigured) {
    await loadApplications();
    await checkFollowUps();
  }
});
