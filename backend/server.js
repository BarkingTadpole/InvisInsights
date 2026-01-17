import express from 'express';
import fetch from 'node-fetch';
import pkg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pkg;
const app = express();

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});


/* -------------------- DB -------------------- */

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: process.env.PGSSLMODE === 'require'
    ? { rejectUnauthorized: false }
    : false
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

const INTENTS = [
  'OVERALL_SATISFACTION',
  'EASE_OF_USE',
  'CONFUSION_LEVEL',
  'FRUSTRATION_LEVEL',
  'TRUST_CONFIDENCE',
  'LIKELIHOOD_TO_CONTINUE',
  'OPEN_FEEDBACK'
];

function generateProjectKey() {
  return crypto.randomUUID();
}

function getHost(req) {
  const v = req.headers.origin || req.headers.referer;
  if (!v) return null;
  try { return new URL(v).hostname; } catch { return null; }
}

async function getProject(projectKey) {
  const { rows } = await pool.query(
    'SELECT * FROM projects WHERE project_key = $1',
    [projectKey]
  );
  return rows[0] || null;
}

async function upsertProject(data) {
  await pool.query(`
    INSERT INTO projects (
      project_key,
      allowed_domain,
      surveymonkey_access_token,
      survey_id,
      survey_config,
      setup_complete
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (project_key)
    DO UPDATE SET
      allowed_domain = EXCLUDED.allowed_domain,
      surveymonkey_access_token = EXCLUDED.surveymonkey_access_token,
      survey_id = EXCLUDED.survey_id,
      survey_config = EXCLUDED.survey_config,
      setup_complete = EXCLUDED.setup_complete,
      updated_at = now()
  `, [
    data.project_key,
    data.allowed_domain,
    data.surveymonkey_access_token,
    data.survey_id,
    data.survey_config,
    data.setup_complete
  ]);
}

/* -------------------- AUTH MIDDLEWARE -------------------- */

async function requireProject(req, res, next) {
  const key = req.header('X-Invis-Project-Key');
  if (!key) return res.status(401).json({ error: 'missing_project_key' });

  const project = await getProject(key);
  if (!project) return res.status(401).json({ error: 'invalid_project_key' });

  const host = getHost(req);
  if (project.allowed_domain && host && host !== project.allowed_domain) {
    return res.status(403).json({ error: 'domain_not_allowed' });
  }

  req.project = project;
  next();
}

/* -------------------- PROJECT STATUS -------------------- */

app.get('/project-status', async (req, res) => {
  const key = req.header('X-Invis-Project-Key');
  if (!key) return res.json({ needs_setup: true });

  const project = await getProject(key);
  if (!project || !project.setup_complete) {
    return res.json({ needs_setup: true });
  }
  return res.json({ needs_setup: false });
});

/* -------------------- CONNECT SURVEYMONKEY -------------------- */

app.get('/connect-surveymonkey', (req, res) => {
  const projectKey = req.query.project_key || '';
  res.send(`
<!doctype html>
<html>
<body>
<h2>Connect SurveyMonkey</h2>
<input id="token" placeholder="Access token"/>
<button onclick="load()">Load Surveys</button>
<select id="survey"></select>
<button onclick="connect()">Connect</button>
<script>
const pk = ${JSON.stringify(projectKey)};
async function load() {
  const r = await fetch('/surveymonkey/surveys', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ access_token:token.value })
  });
  const d = await r.json();
  survey.innerHTML = d.surveys.map(s=>\`<option value="\${s.id}">\${s.title}</option>\`).join('');
}
async function connect() {
  await fetch('/connect-surveymonkey',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      project_key: pk,
      access_token: token.value,
      survey_id: survey.value
    })
  });
  alert('Connected');
}
</script>
</body>
</html>
`);
});

app.post('/connect-surveymonkey', async (req, res) => {
  const { project_key, access_token, survey_id } = req.body;
  if (!access_token || !survey_id) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const surveys = await fetchSurveyList(access_token);
  if (!surveys.find(s => s.id === survey_id)) {
    return res.status(400).json({ error: 'survey_not_found' });
  }

  const details = await fetchSurveyDetails(survey_id, access_token);
  const collectors = await fetchSurveyCollectors(survey_id, access_token);
  if (!collectors.length) {
    return res.status(400).json({ error: 'no_collectors' });
  }

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

  res.json({ ok: true, project_key: finalKey });
});

/* -------------------- COLLECT -------------------- */

app.post('/collect', requireProject, async (req, res) => {
  if (!req.project.setup_complete) {
    return res.json({ ok: true, survey_status: { needs_setup: true } });
  }

  const intents = extractIntents(req.project.survey_config);
  const analysis = await runAI(req.body, intents);

  await submitSurveyMonkey({
    analysis,
    config: req.project.survey_config,
    token: req.project.surveymonkey_access_token
  });

  res.json({ ok: true });
});

/* -------------------- AI -------------------- */

function buildPrompt(session, intents) {
  return `
Analyze UX behavior.

INTENTS:
${intents.map(i=>'- '+i).join('\n')}

Session:
${JSON.stringify(session)}

Return JSON:
{
  "intent_scores": { ${intents.map(i=>`"${i}":0.0`).join(',')} },
  "confidence": { ${intents.map(i=>`"${i}":0.0`).join(',')} },
  "open_feedback": []
}
`;
}

async function runAI(session, intents) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'Authorization':'Bearer '+process.env.OPENROUTER_API_KEY
    },
    body:JSON.stringify({
      model:'@preset/invisinsights',
      messages:[{role:'user',content:buildPrompt(session,intents)}],
      temperature:0.2
    })
  });
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

/* -------------------- SURVEYMONKEY -------------------- */

async function fetchSurveyList(token) {
  const r = await fetch('https://api.surveymonkey.com/v3/surveys',{
    headers:{Authorization:'Bearer '+token}
  });
  return (await r.json()).data || [];
}

async function fetchSurveyDetails(id, token) {
  const r = await fetch(`https://api.surveymonkey.com/v3/surveys/${id}/details`,{
    headers:{Authorization:'Bearer '+token}
  });
  return r.json();
}

async function fetchSurveyCollectors(id, token) {
  const r = await fetch(`https://api.surveymonkey.com/v3/surveys/${id}/collectors`,{
    headers:{Authorization:'Bearer '+token}
  });
  return (await r.json()).data || [];
}

/* -------------------- START -------------------- */

const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log('InvisInsights running on', port);
  try {
    await initDb();
    console.log('DB ready');
  } catch (err) {
    console.error('DB init failed', err);
  }
});