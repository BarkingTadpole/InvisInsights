// backend/server.js (ESM)
import express from 'express';
import fetch from 'node-fetch';
import pg from 'pg';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// If your repo has /frontend at project root (not /backend/frontend)
const FRONTEND_DIR =
  process.env.FRONTEND_DIR ||
  path.join(__dirname, '..', 'frontend'); // <-- change to path.join(__dirname,'frontend') if needed

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(FRONTEND_DIR));
app.get('/', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

/* -------------------- DB -------------------- */

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL missing');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      project_key TEXT PRIMARY KEY,
      allowed_domain TEXT,
      surveymonkey_access_token TEXT,
      survey_id TEXT,
      survey_config JSONB,
      setup_complete BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

/* -------------------- HELPERS -------------------- */

const INTENTS = new Set([
  'OVERALL_SATISFACTION',
  'EASE_OF_USE',
  'CONFUSION_LEVEL',
  'FRUSTRATION_LEVEL',
  'TRUST_CONFIDENCE',
  'LIKELIHOOD_TO_CONTINUE',
  'OPEN_FEEDBACK'
]);

function generateProjectKey() {
  return crypto.randomUUID();
}

function getHost(req) {
  const v = req.headers.origin || req.headers.referer;
  if (!v) return null;
  try {
    return new URL(v).hostname;
  } catch {
    return null;
  }
}

async function getProject(projectKey) {
  const { rows } = await pool.query('SELECT * FROM projects WHERE project_key = $1', [projectKey]);
  return rows[0] || null;
}

async function upsertProject(data) {
  await pool.query(
    `
    INSERT INTO projects (
      project_key, allowed_domain, surveymonkey_access_token, survey_id, survey_config, setup_complete
    ) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (project_key) DO UPDATE SET
      allowed_domain = EXCLUDED.allowed_domain,
      surveymonkey_access_token = EXCLUDED.surveymonkey_access_token,
      survey_id = EXCLUDED.survey_id,
      survey_config = EXCLUDED.survey_config,
      setup_complete = EXCLUDED.setup_complete,
      updated_at = now()
  `,
    [
      data.project_key,
      data.allowed_domain ?? null,
      data.surveymonkey_access_token ?? null,
      data.survey_id ?? null,
      data.survey_config ?? null,
      !!data.setup_complete
    ]
  );
}

function extractIntents(config) {
  if (!config || !Array.isArray(config.questions)) return [];
  const intents = new Set();
  for (const q of config.questions) {
    if (q?.inferred_intent && INTENTS.has(q.inferred_intent)) intents.add(q.inferred_intent);
  }
  return [...intents];
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/* -------------------- AUTH MIDDLEWARE -------------------- */

async function requireProject(req, res, next) {
  try {
    const key = req.header('X-Invis-Project-Key');
    if (!key) return res.status(401).json({ error: 'missing_project_key' });

    const project = await getProject(key);
    if (!project) return res.status(401).json({ error: 'invalid_project_key' });

    // domain lock: only enforce if we have a host and project has allowed_domain set
    const host = getHost(req);
    if (project.allowed_domain && host && host !== project.allowed_domain) {
      return res.status(403).json({ error: 'domain_not_allowed' });
    }

    req.project = project;
    return next();
  } catch (e) {
    return res.status(500).json({ error: 'project_lookup_failed' });
  }
}

/* -------------------- PROJECT STATUS -------------------- */

app.get('/project-status', async (req, res) => {
  const key = req.header('X-Invis-Project-Key');
  if (!key) return res.json({ needs_setup: true });

  const project = await getProject(key);
  if (!project || !project.setup_complete) return res.json({ needs_setup: true });
  return res.json({ needs_setup: false });
});

/* -------------------- CONNECT SURVEYMONKEY UI -------------------- */

app.get('/connect-surveymonkey', (req, res) => {
  const projectKey = req.query.project_key || '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect SurveyMonkey</title></head>
<body style="font-family:Arial;max-width:720px;margin:40px auto">
<h2>Connect SurveyMonkey</h2>
<p>Paste a SurveyMonkey access token, load surveys, choose one, connect.</p>
<input id="token" placeholder="Access token" style="width:100%;padding:10px"/>
<button id="load" style="margin-top:10px;padding:10px 14px">Load Surveys</button>
<select id="survey" style="display:block;width:100%;padding:10px;margin-top:10px"></select>
<button id="connect" style="margin-top:10px;padding:10px 14px">Connect</button>
<pre id="out" style="background:#f6f6f6;padding:12px;margin-top:16px"></pre>
<script>
const pk = ${JSON.stringify(projectKey)};
const out = document.getElementById('out');
const token = document.getElementById('token');
const survey = document.getElementById('survey');

document.getElementById('load').onclick = async () => {
  out.textContent = 'Loading...';
  const r = await fetch('/surveymonkey/surveys', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ access_token: token.value })
  });
  const d = await r.json();
  if(!r.ok){ out.textContent = JSON.stringify(d,null,2); return; }
  survey.innerHTML = (d.surveys||[]).map(s => '<option value="'+s.id+'">'+(s.title||s.id)+'</option>').join('');
  out.textContent = 'Loaded ' + (d.surveys||[]).length + ' surveys.';
};

document.getElementById('connect').onclick = async () => {
  out.textContent = 'Connecting...';
  const r = await fetch('/connect-surveymonkey', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ project_key: pk, access_token: token.value, survey_id: survey.value })
  });
  const d = await r.json();
  out.textContent = JSON.stringify(d,null,2);
};
</script>
</body></html>`);
});

/* -------------------- SURVEYMONKEY: LIST + CONNECT -------------------- */

app.post('/surveymonkey/surveys', async (req, res) => {
  const token = req.body?.access_token;
  if (!token) return res.status(400).json({ error: 'missing_access_token' });
  try {
    const surveys = await fetchSurveyList(token);
    return res.json({ surveys });
  } catch (e) {
    return res.status(500).json({ error: 'survey_list_failed', detail: e.message });
  }
});

app.post('/connect-surveymonkey', async (req, res) => {
  const { project_key, access_token, survey_id } = req.body || {};
  if (!access_token || !survey_id) return res.status(400).json({ error: 'missing_fields' });

  try {
    const surveys = await fetchSurveyList(access_token);
    if (!surveys.find((s) => String(s.id) === String(survey_id))) {
      return res.status(400).json({ error: 'survey_not_found' });
    }

    const details = await fetchSurveyDetails(survey_id, access_token);
    const collectors = await fetchSurveyCollectors(survey_id, access_token);
    if (!collectors.length) return res.status(400).json({ error: 'no_collectors' });

    const config = autoMapSurveyToConfig(survey_id, collectors[0].id, details);
    const finalKey = project_key || generateProjectKey();

    await upsertProject({
      project_key: finalKey,
      allowed_domain: getHost(req),
      surveymonkey_access_token: access_token,
      survey_id,
      survey_config: config,
      setup_complete: true
    });

    return res.json({ ok: true, project_key: finalKey, survey_id });
  } catch (e) {
    return res.status(500).json({ error: 'connect_failed', detail: e.message });
  }
});

/* -------------------- COLLECT -------------------- */

app.post('/collect', requireProject, async (req, res) => {
  try {
    if (!req.project.setup_complete || !req.project.survey_config) {
      return res.json({ ok: true, survey_status: { needs_setup: true } });
    }

    const config = req.project.survey_config;
    const intents = extractIntents(config);
    if (!intents.length) return res.json({ ok: true, error: 'no_intents_mapped' });

    const analysis = await runAI(req.body, intents);

    await submitSurveyMonkey({
      analysis,
      config,
      token: req.project.surveymonkey_access_token
    });

    return res.json({ ok: true, survey_status: { needs_setup: false } });
  } catch (e) {
    return res.status(500).json({ error: 'collect_failed', detail: e.message });
  }
});

/* -------------------- AI (OpenRouter) -------------------- */

function buildPrompt(session, intents) {
  return (
    `You are a UX analytics assistant. Interpret the session JSON as behavioral signals.\n` +
    `Return ONLY valid JSON. No prose.\n` +
    `Use normalized intent scores 0..1. If weak evidence, use 0.5 with low confidence.\n\n` +
    `INTENTS:\n${intents.map((i) => `- ${i}`).join('\n')}\n\n` +
    `Session:\n${JSON.stringify(session, null, 2)}\n\n` +
    `Return JSON schema:\n{\n` +
    `  "intent_scores": { ${intents.map((i) => `"${i}": 0.0`).join(', ')} },\n` +
    `  "confidence": { ${intents.map((i) => `"${i}": 0.0`).join(', ')} },\n` +
    `  "open_feedback": []\n` +
    `}\n`
  );
}

async function runAI(session, intents) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || '@preset/invisinsights',
      messages: [{ role: 'user', content: buildPrompt(session, intents) }],
      temperature: 0.2
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`openrouter_error: ${t}`);
  }

  const j = await r.json();
  const raw = j?.choices?.[0]?.message?.content ?? '';
  const parsed = safeJsonParse(raw);
  if (!parsed) throw new Error('ai_returned_non_json');
  return parsed;
}

/* -------------------- SURVEYMONKEY API -------------------- */

async function fetchSurveyList(token) {
  const r = await fetch('https://api.surveymonkey.com/v3/surveys', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j?.data || [];
}

async function fetchSurveyDetails(id, token) {
  const r = await fetch(`https://api.surveymonkey.com/v3/surveys/${id}/details`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function fetchSurveyCollectors(id, token) {
  const r = await fetch(`https://api.surveymonkey.com/v3/surveys/${id}/collectors`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j?.data || [];
}

/* ---- auto map survey -> config ---- */

function extractQuestionText(question) {
  if (question?.headings?.[0]?.heading) return String(question.headings[0].heading);
  if (question?.heading) return String(question.heading);
  return '';
}

function inferIntentFromText(text, type) {
  const v = String(text || '').toLowerCase();
  if (type === 'text') return 'OPEN_FEEDBACK';
  if (v.includes('confus') || v.includes('unclear')) return 'CONFUSION_LEVEL';
  if (v.includes('frustrat') || v.includes('annoy') || v.includes('angry')) return 'FRUSTRATION_LEVEL';
  if (v.includes('trust') || v.includes('secure') || v.includes('safe')) return 'TRUST_CONFIDENCE';
  if (v.includes('easy') || v.includes('ease') || v.includes('simple') || v.includes('usable')) return 'EASE_OF_USE';
  if (v.includes('recommend') || v.includes('likely') || v.includes('continue') || v.includes('return')) return 'LIKELIHOOD_TO_CONTINUE';
  if (v.includes('satisf') || v.includes('overall') || v.includes('experience')) return 'OVERALL_SATISFACTION';
  return 'OVERALL_SATISFACTION';
}

function buildChoiceMap(choices) {
  const map = {};
  // try parse numeric labels
  const nums = choices
    .map((c) => {
      const m = String(c?.text || '').match(/-?\d+/);
      return m ? Number(m[0]) : null;
    })
    .filter((n) => Number.isFinite(n));

  if (nums.length === choices.length && choices.length > 0) {
    for (const c of choices) {
      const m = String(c?.text || '').match(/-?\d+/);
      const val = m ? String(Number(m[0])) : null;
      if (val != null) map[val] = c.id;
    }
    return { map, min: Math.min(...nums), max: Math.max(...nums) };
  }

  // fallback 1..N
  choices.forEach((c, i) => (map[String(i + 1)] = c.id));
  return { map, min: 1, max: choices.length };
}

function resolveBooleanChoices(choices) {
  if (!choices || choices.length !== 2) return null;
  const a = String(choices[0]?.text || '').toLowerCase();
  const b = String(choices[1]?.text || '').toLowerCase();
  const aFalse = a.includes('no') || a.includes('false');
  const bFalse = b.includes('no') || b.includes('false');
  if (aFalse && !bFalse) return { true_choice_id: choices[1].id, false_choice_id: choices[0].id };
  if (bFalse && !aFalse) return { true_choice_id: choices[0].id, false_choice_id: choices[1].id };
  // default: first=true second=false
  return { true_choice_id: choices[0].id, false_choice_id: choices[1].id };
}

function autoMapSurveyToConfig(surveyId, collectorId, details) {
  const pages = details?.pages || [];
  if (!pages.length) throw new Error('survey_details_missing_pages');

  const questions = [];

  for (const page of pages) {
    for (const q of page?.questions || []) {
      const family = String(q?.family || '').toLowerCase();
      const text = extractQuestionText(q);

      if (family === 'open_ended') {
        questions.push({
          page_id: page.id,
          question_id: q.id,
          type: 'text',
          inferred_intent: 'OPEN_FEEDBACK',
          question_text: text
        });
        continue;
      }

      if (family === 'single_choice') {
        const choices = q?.answers?.choices || [];
        if (choices.length === 2) {
          const bc = resolveBooleanChoices(choices);
          questions.push({
            page_id: page.id,
            question_id: q.id,
            type: 'boolean',
            inferred_intent: inferIntentFromText(text, 'boolean'),
            true_choice_id: bc.true_choice_id,
            false_choice_id: bc.false_choice_id,
            question_text: text
          });
        } else if (choices.length > 2) {
          const cm = buildChoiceMap(choices);
          questions.push({
            page_id: page.id,
            question_id: q.id,
            type: 'scale',
            inferred_intent: inferIntentFromText(text, 'scale'),
            scale_min: cm.min,
            scale_max: cm.max,
            choice_ids: cm.map,
            question_text: text
          });
        }
        continue;
      }

      if (family === 'matrix') {
        const choices = q?.answers?.choices || [];
        const rows = q?.answers?.rows || [];
        if (choices.length && rows.length) {
          const cm = buildChoiceMap(choices);
          questions.push({
            page_id: page.id,
            question_id: q.id,
            type: 'scale',
            inferred_intent: inferIntentFromText(text, 'scale'),
            scale_min: cm.min,
            scale_max: cm.max,
            choice_ids: cm.map,
            row_id: rows[0].id,
            question_text: text
          });
        }
      }
    }
  }

  return {
    survey_id: surveyId,
    collector_id: collectorId,
    // default page fallback if needed
    page_id: pages[0].id,
    questions
  };
}

/* ---- map analysis -> survey answers + submit ---- */

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function scoreToScale(score01, min, max) {
  const raw = min + (max - min) * score01;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function openFeedbackText(analysis) {
  const arr = Array.isArray(analysis?.open_feedback) ? analysis.open_feedback : [];
  return arr.map((s) => String(s || '').trim()).filter(Boolean).join('\n');
}

function buildSurveyPagesPayload(analysis, config) {
  const pageMap = new Map();

  for (const q of config.questions || []) {
    const type = q.type;
    const intent = q.inferred_intent;
    const score = clamp01(analysis?.intent_scores?.[intent]);
    const conf = clamp01(analysis?.confidence?.[intent]);

    let questionPayload = null;

    if (type === 'text') {
      const text = openFeedbackText(analysis);
      if (text) {
        questionPayload = { id: q.question_id, answers: [{ text }] };
      }
    } else if (type === 'boolean') {
      if (score != null) {
        const choiceId = score >= 0.5 ? q.true_choice_id : q.false_choice_id;
        if (choiceId) questionPayload = { id: q.question_id, answers: [{ choice_id: choiceId }] };
      }
    } else if (type === 'scale') {
      if (score != null) {
        const min = Number(q.scale_min);
        const max = Number(q.scale_max);
        const value = scoreToScale(score, min, max);
        const choiceId = q.choice_ids?.[String(value)];
        if (choiceId) {
          const ans = { choice_id: choiceId };
          if (q.row_id) ans.row_id = q.row_id;
          questionPayload = { id: q.question_id, answers: [ans] };
        }
      }
    }

    // optional: skip low confidence answers (except scale/boolean; keep it simple)
    if (!questionPayload) continue;

    const pid = q.page_id || config.page_id;
    if (!pageMap.has(pid)) pageMap.set(pid, []);
    pageMap.get(pid).push(questionPayload);
  }

  return [...pageMap.entries()].map(([id, questions]) => ({ id, questions }));
}

async function submitSurveyMonkey({ analysis, config, token }) {
  const pages = buildSurveyPagesPayload(analysis, config);
  if (!pages.length) return;

  const body = { response_status: 'completed', pages };

  const r = await fetch(`https://api.surveymonkey.com/v3/collectors/${config.collector_id}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`surveymonkey_submit_failed: ${t}`);
  }
}

/* -------------------- START -------------------- */

const port = process.env.PORT || 3000;

(async () => {
  try {
    await initDb();
    console.log('DB ready');
    app.listen(port, () => console.log('InvisInsights running on', port));
  } catch (e) {
    console.error('FATAL boot error:', e);
    process.exit(1);
  }
})();