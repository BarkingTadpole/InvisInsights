const express = require('express');
const app = express();

app.use(express.json({ limit: '200kb' }));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

const sessions = [];
const projectStore = new Map();

app.get('/project-status', (req, res) => {
  const projectId = req.query.project_id;
  if (!projectId) {
    return res.status(400).json({ error: 'missing project_id' });
  }
  const config = getProjectConfig(projectId);
  const connected = !!config;
  return res.json({
    surveymonkey_connected: connected,
    setup_url: connected ? null : '/connect-surveymonkey?project_id=' + encodeURIComponent(projectId)
  });
});

app.get('/connect-surveymonkey', (req, res) => {
  const projectId = req.query.project_id || '';
  const html =
    '<!doctype html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>Connect SurveyMonkey</title>' +
    '<style>' +
    'body{font-family:Arial,Helvetica,sans-serif;margin:40px;background:#f7f7f7;color:#222;}' +
    '.card{max-width:520px;margin:0 auto;background:#fff;padding:24px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.08);}' +
    'label{display:block;margin-top:16px;font-weight:600;}' +
    'input,select,button{width:100%;padding:10px;margin-top:8px;border:1px solid #ccc;border-radius:8px;font-size:14px;}' +
    'button{background:#0f62fe;color:#fff;border:none;cursor:pointer;}' +
    'button.secondary{background:#444;margin-top:12px;}' +
    '.status{margin-top:12px;font-size:13px;color:#555;}' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<div class="card">' +
    '<h2>Connect SurveyMonkey</h2>' +
    '<p>Paste a SurveyMonkey access token and select a survey.</p>' +
    '<label>Access Token</label>' +
    '<input id="token" type="password" placeholder="SurveyMonkey access token" />' +
    '<button id="load" class="secondary" type="button">Load Surveys</button>' +
    '<label>Survey</label>' +
    '<select id="survey"><option value="">Select a survey</option></select>' +
    '<button id="connect" type="button">Connect</button>' +
    '<div class="status" id="status"></div>' +
    '</div>' +
    '<script>' +
    'const projectId=' + JSON.stringify(projectId) + ';' +
    'const statusEl=document.getElementById("status");' +
    'const surveyEl=document.getElementById("survey");' +
    'document.getElementById("load").addEventListener("click", async () => {' +
    '  statusEl.textContent="Loading surveys...";' +
    '  const token=document.getElementById("token").value.trim();' +
    '  if(!token){statusEl.textContent="Enter access token.";return;}' +
    '  const res=await fetch("/surveymonkey/surveys",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({access_token:token})});' +
    '  if(!res.ok){statusEl.textContent="Failed to load surveys.";return;}' +
    '  const data=await res.json();' +
    '  surveyEl.innerHTML="<option value=\\"\\">Select a survey</option>";' +
    '  (data.surveys||[]).forEach(s=>{const opt=document.createElement("option");opt.value=s.id;opt.textContent=s.title||s.id;surveyEl.appendChild(opt);});' +
    '  statusEl.textContent="Select a survey to connect.";' +
    '});' +
    'document.getElementById("connect").addEventListener("click", async () => {' +
    '  statusEl.textContent="Connecting...";' +
    '  const token=document.getElementById("token").value.trim();' +
    '  const surveyId=surveyEl.value;' +
    '  if(!token||!surveyId){statusEl.textContent="Token and survey required.";return;}' +
    '  const res=await fetch("/connect-surveymonkey",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project_id:projectId,access_token:token,survey_id:surveyId})});' +
    '  const data=await res.json();' +
    '  if(!res.ok){statusEl.textContent=data.error||"Connect failed.";return;}' +
    '  statusEl.textContent="Connected. You can close this tab.";' +
    '});' +
    '</script>' +
    '</body>' +
    '</html>';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
});

app.post('/surveymonkey/surveys', async (req, res) => {
  const accessToken = req.body && req.body.access_token;
  if (!accessToken) {
    return res.status(400).json({ error: 'missing access_token' });
  }
  try {
    const surveys = await fetchSurveyList(accessToken);
    return res.json({ surveys: surveys });
  } catch (err) {
    return res.status(500).json({ error: 'survey_list_failed', detail: err.message });
  }
});

app.post('/connect-surveymonkey', async (req, res) => {
  const projectId = req.body && req.body.project_id;
  const accessToken = req.body && req.body.access_token;
  const surveyId = req.body && req.body.survey_id;

  if (!projectId || !accessToken || !surveyId) {
    return res.status(400).json({ error: 'missing project_id, access_token, or survey_id' });
  }

  try {
    const surveys = await fetchSurveyList(accessToken);
    const surveyMatch = surveys.find((survey) => String(survey.id) === String(surveyId));
    if (!surveyMatch) {
      return res.status(400).json({ error: 'survey_id not found for token' });
    }
    const surveyDetails = await fetchSurveyDetails(surveyId, accessToken);
    const collectors = await fetchSurveyCollectors(surveyId, accessToken);
    if (!collectors.length) {
      return res.status(400).json({ error: 'no collectors found for survey' });
    }

    const config = autoMapSurveyToConfig(surveyId, collectors[0].id, surveyDetails);
    const normalized = normalizeSurveyConfig(config);
    if (!normalized) {
      return res.status(400).json({ error: 'survey_mapping_failed' });
    }
    projectStore.set(projectId, { config: normalized, access_token: accessToken });

    return res.json({ ok: true, surveymonkey_connected: true });
  } catch (err) {
    return res.status(500).json({ error: 'connect_failed', detail: err.message });
  }
});

// POST /collect
app.post('/collect', async (req, res) => {
  const session = req.body;
  if (!session || !session.session_id) {
    return res.status(400).json({ error: 'missing session_id' });
  }

  sessions.push({ session, received_at_ms: Date.now() });
  if (sessions.length > 100) {
    sessions.shift();
  }

  console.log('[collect] session summary:', JSON.stringify(session, null, 2));

  const projectId = session.project_id || session.projectId || session.project || null;
  let surveyStatus = { surveymonkey_connected: false, setup_required: true };

  const surveyConfig = resolveSurveyMonkeyConfig(projectId);
  if (!surveyConfig) {
    console.log('[survey] skipped: missing SurveyMonkey config');
    return res.json({ ok: true, survey_status: surveyStatus });
  }

  const intents = getIntentsFromConfig(surveyConfig.config);
  if (!intents.length) {
    console.log('[survey] skipped: no intents resolved');
    return res.json({ ok: true, survey_status: surveyStatus });
  }

  try {
    const analysis = await runOpenRouterAnalysis(session, intents);
    console.log('[analyze] result:', JSON.stringify(analysis, null, 2));
    await submitSurveyMonkeyResponse({
      session_id: session.session_id,
      analysis: analysis,
      config: surveyConfig.config,
      access_token: surveyConfig.access_token
    });
    console.log('[survey] response created');
    surveyStatus = { surveymonkey_connected: true, setup_required: false };
  } catch (err) {
    console.error('[analyze] error:', err.message);
  }

  return res.json({ ok: true, survey_status: surveyStatus });
});

// POST /analyze
app.post('/analyze', async (req, res) => {
  const session = req.body;
  if (!session || !session.session_id) {
    return res.status(400).json({ error: 'missing session_id' });
  }

  try {
    const projectId = session.project_id || session.projectId || session.project || null;
    const surveyConfig = resolveSurveyMonkeyConfig(projectId, req.body);
    if (!surveyConfig) {
      return res.json({
        survey_status: { surveymonkey_connected: false, setup_required: true }
      });
    }

    const intents = getIntentsFromConfig(surveyConfig.config);
    if (!intents.length) {
      return res.json({
        survey_status: { surveymonkey_connected: false, setup_required: true }
      });
    }

    const analysis = await runOpenRouterAnalysis(session, intents);
    await submitSurveyMonkeyResponse({
      session_id: session.session_id,
      analysis: analysis,
      config: surveyConfig.config,
      access_token: surveyConfig.access_token
    });
    return res.json({
      analysis: analysis,
      survey_status: { surveymonkey_connected: true, setup_required: false }
    });
  } catch (err) {
    return res.status(500).json({ error: 'analysis_failed', detail: err.message });
  }
});

function buildOpenRouterPrompt(session, intents) {
  const uniqueIntents = Array.from(new Set(intents || []));
  if (!uniqueIntents.length) {
    throw new Error('No intents provided for analysis');
  }
  const intentLines = uniqueIntents.map((intent) => '    "' + intent + '": number (0-1)');
  const confidenceLines = uniqueIntents.map((intent) => '    "' + intent + '": number (0-1)');
  const intentList = uniqueIntents.map((intent) => '- ' + intent).join('\n');
  return (
    'You are a UX analytics assistant. Interpret the session summary as behavioral signals.' +
    '\n' +
    'Return ONLY valid JSON with the specified fields.' +
    '\n' +
    'Do not assume any survey wording or scale. Use only normalized intent scores.' +
    '\n' +
    'Use probabilistic language (likely, suggests, indicates). Avoid absolute claims.' +
    '\n' +
    'If evidence is weak, use 0.5 with low confidence.' +
    '\n\n' +
    'INTENTS:\n' +
    intentList +
    '\n\n' +
    'Session summary JSON:\n' +
    JSON.stringify(session, null, 2) +
    '\n\n' +
    'Required JSON output schema:\n' +
    '{\n' +
    '  "intent_scores": {\n' +
    intentLines.join(',\n') +
    '  },\n' +
    '  "confidence": {\n' +
    confidenceLines.join(',\n') +
    '  },\n' +
    '  "open_feedback": string[]\n' +
    '}'
  );
}

// Run OpenRouter analysis
async function runOpenRouterAnalysis(session, intents) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set');
  }

  const prompt = buildOpenRouterPrompt(session, intents);
  const model = process.env.OPENROUTER_MODEL || '@preset/invisinsights';
  const referer = process.env.OPENROUTER_HTTP_REFERER || 'http://localhost';
  const title = process.env.OPENROUTER_APP_TITLE || 'InvisInsights';
  const response = await fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        'HTTP-Referer': referer,
        'X-Title': title
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        top_p: 0.8
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error('OpenRouter error: ' + text);
  }

  const data = await response.json();
  const rawText = extractChatContent(data);

  const parsed = safeJsonParse(rawText);
  if (!parsed) {
    throw new Error('OpenRouter returned non-JSON response');
  }

  return parsed;
}

function extractChatContent(data) {
  if (!data || !Array.isArray(data.choices) || !data.choices[0]) {
    return '';
  }
  var message = data.choices[0].message;
  if (!message || typeof message.content !== 'string') {
    return '';
  }
  return message.content;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    var match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch (err) {
      return null;
    }
  }
}

const INTENTS = [
  'OVERALL_SATISFACTION',
  'EASE_OF_USE',
  'CONFUSION_LEVEL',
  'FRUSTRATION_LEVEL',
  'TRUST_CONFIDENCE',
  'LIKELIHOOD_TO_CONTINUE',
  'OPEN_FEEDBACK'
];

const INTENT_SET = new Set(INTENTS);

function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, value));
}

function getIntentScore(analysis, intent) {
  if (!analysis || !analysis.intent_scores || typeof analysis.intent_scores[intent] !== 'number') {
    return null;
  }
  return clamp01(analysis.intent_scores[intent]);
}

function getIntentConfidence(analysis, intent) {
  if (!analysis || !analysis.confidence || typeof analysis.confidence[intent] !== 'number') {
    return null;
  }
  return clamp01(analysis.confidence[intent]);
}

function getOpenFeedback(analysis) {
  if (!analysis || !Array.isArray(analysis.open_feedback)) {
    return '';
  }
  const cleaned = analysis.open_feedback
    .map((item) => (item == null ? '' : String(item).trim()))
    .filter((item) => item.length > 0);
  return cleaned.join('\n');
}

function getIntentsFromConfig(config) {
  const intents = new Set();
  if (!config || !Array.isArray(config.questions)) {
    return [];
  }
  for (const question of config.questions) {
    if (question && INTENT_SET.has(question.inferred_intent)) {
      intents.add(question.inferred_intent);
    }
  }
  return Array.from(intents);
}

function normalizeQuestionType(type) {
  return String(type || '').trim().toLowerCase();
}

function isValidQuestionConfig(question) {
  if (!question || !question.question_id || !question.type || !question.inferred_intent) {
    return false;
  }
  if (!INTENT_SET.has(question.inferred_intent)) {
    return false;
  }
  const type = normalizeQuestionType(question.type);
  if (type === 'scale') {
    return (
      Number.isFinite(Number(question.scale_min)) &&
      Number.isFinite(Number(question.scale_max)) &&
      Number(question.scale_min) !== Number(question.scale_max) &&
      question.choice_ids &&
      typeof question.choice_ids === 'object'
    );
  }
  if (type === 'boolean') {
    return !!question.true_choice_id && !!question.false_choice_id;
  }
  if (type === 'text') {
    return true;
  }
  return false;
}

function resolveSurveyMonkeyConfig(projectId, body) {
  const requestConfig = body && body.surveymonkey_config ? body.surveymonkey_config : null;
  if (requestConfig) {
    const normalized = normalizeSurveyConfig(requestConfig);
    return normalized ? { config: normalized, access_token: null } : null;
  }

  if (projectId && projectStore.has(projectId)) {
    return projectStore.get(projectId);
  }

  return null;
}

function getProjectConfig(projectId) {
  if (!projectId) {
    return null;
  }
  if (projectStore.has(projectId)) {
    return projectStore.get(projectId);
  }
  return null;
}

function normalizeSurveyConfig(config) {
  if (!config || !config.survey_id || !config.collector_id || !config.page_id) {
    return null;
  }
  if (!Array.isArray(config.questions) || config.questions.length === 0) {
    return null;
  }
  for (const question of config.questions) {
    if (!isValidQuestionConfig(question)) {
      return null;
    }
  }
  return config;
}

function mapScoreToScale(score, min, max) {
  const raw = min + (max - min) * score;
  const rounded = Math.round(raw);
  return Math.min(max, Math.max(min, rounded));
}

function buildQuestionAnswer(question, analysis) {
  const type = normalizeQuestionType(question.type);
  if (type === 'text') {
    const confidence = getIntentConfidence(analysis, question.inferred_intent);
    const threshold = typeof question.confidence_threshold === 'number' ? question.confidence_threshold : 0.6;
    if (confidence !== null && confidence < threshold) {
      return null;
    }
    const text = getOpenFeedback(analysis);
    if (!text) {
      return null;
    }
    return { id: question.question_id, answers: [{ text: text }] };
  }

  const score = getIntentScore(analysis, question.inferred_intent);
  if (score === null) {
    return null;
  }

  if (type === 'boolean') {
    const threshold = typeof question.threshold === 'number' ? question.threshold : 0.5;
    const choiceId = score >= threshold ? question.true_choice_id : question.false_choice_id;
    if (!choiceId) {
      throw new Error('SurveyMonkey boolean choice IDs missing for question ' + question.question_id);
    }
    return { id: question.question_id, answers: [{ choice_id: choiceId }] };
  }

  if (type === 'scale') {
    const min = Number(question.scale_min);
    const max = Number(question.scale_max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      return null;
    }
    const value = mapScoreToScale(score, min, max);
    const choiceId = question.choice_ids ? question.choice_ids[String(value)] : null;
    if (!choiceId) {
      throw new Error('SurveyMonkey scale choice ID not resolved for question ' + question.question_id);
    }
    const answer = { choice_id: choiceId };
    const rowId = question.row_id || null;
    if (rowId) {
      answer.row_id = rowId;
    }
    return { id: question.question_id, answers: [answer] };
  }

  return null;
}

function buildSurveyPagesPayload(analysis, config) {
  const pages = new Map();
  for (const question of config.questions) {
    const answer = buildQuestionAnswer(question, analysis);
    if (!answer) {
      continue;
    }
    const pageId = question.page_id || config.page_id;
    if (!pageId) {
      continue;
    }
    if (!pages.has(pageId)) {
      pages.set(pageId, []);
    }
    pages.get(pageId).push(answer);
  }
  return Array.from(pages.entries()).map(([id, questions]) => ({ id: id, questions: questions }));
}

async function fetchSurveyList(accessToken) {
  const response = await fetch('https://api.surveymonkey.com/v3/surveys', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + accessToken
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error('SurveyMonkey list error: ' + text);
  }
  const data = await response.json();
  return data && Array.isArray(data.data) ? data.data : [];
}

async function fetchSurveyDetails(surveyId, accessToken) {
  const response = await fetch('https://api.surveymonkey.com/v3/surveys/' + surveyId + '/details', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + accessToken
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error('SurveyMonkey details error: ' + text);
  }
  return response.json();
}

async function fetchSurveyCollectors(surveyId, accessToken) {
  const response = await fetch('https://api.surveymonkey.com/v3/surveys/' + surveyId + '/collectors', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + accessToken
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error('SurveyMonkey collectors error: ' + text);
  }
  const data = await response.json();
  return data && Array.isArray(data.data) ? data.data : [];
}

function extractQuestionText(question) {
  if (question.headings && question.headings[0] && question.headings[0].heading) {
    return String(question.headings[0].heading);
  }
  if (question.heading) {
    return String(question.heading);
  }
  return '';
}

function inferIntentFromText(text, type) {
  const value = String(text || '').toLowerCase();
  if (type === 'text') {
    return 'OPEN_FEEDBACK';
  }
  if (value.includes('confus') || value.includes('unclear') || value.includes('confusing')) {
    return 'CONFUSION_LEVEL';
  }
  if (value.includes('frustrat') || value.includes('annoy') || value.includes('angry')) {
    return 'FRUSTRATION_LEVEL';
  }
  if (value.includes('trust') || value.includes('confiden') || value.includes('secure') || value.includes('safe')) {
    return 'TRUST_CONFIDENCE';
  }
  if (value.includes('easy') || value.includes('ease') || value.includes('simple') || value.includes('usable')) {
    return 'EASE_OF_USE';
  }
  if (value.includes('recommend') || value.includes('likely') || value.includes('continue') || value.includes('return')) {
    return 'LIKELIHOOD_TO_CONTINUE';
  }
  if (value.includes('satisf') || value.includes('overall') || value.includes('experience')) {
    return 'OVERALL_SATISFACTION';
  }
  if (type === 'boolean') {
    return 'CONFUSION_LEVEL';
  }
  return 'OVERALL_SATISFACTION';
}

function buildChoiceMap(choices) {
  const map = {};
  const numeric = [];
  for (const choice of choices) {
    const text = choice && choice.text ? String(choice.text) : '';
    const match = text.match(/-?\\d+/);
    const value = match ? Number(match[0]) : null;
    if (Number.isFinite(value)) {
      numeric.push(value);
    }
  }
  if (numeric.length === choices.length && choices.length > 0) {
    const min = Math.min.apply(null, numeric);
    const max = Math.max.apply(null, numeric);
    choices.forEach((choice, index) => {
      const text = choice && choice.text ? String(choice.text) : '';
      const match = text.match(/-?\\d+/);
      const value = match ? Number(match[0]) : index + 1;
      map[String(value)] = choice.id;
    });
    return { map: map, min: min, max: max };
  }
  choices.forEach((choice, index) => {
    map[String(index + 1)] = choice.id;
  });
  return { map: map, min: 1, max: choices.length };
}

function resolveBooleanChoices(choices) {
  if (!choices || choices.length !== 2) {
    return null;
  }
  const firstText = String(choices[0].text || '').toLowerCase();
  const secondText = String(choices[1].text || '').toLowerCase();
  const firstIsFalse = firstText.includes('no') || firstText.includes('false');
  const secondIsFalse = secondText.includes('no') || secondText.includes('false');
  if (firstIsFalse && !secondIsFalse) {
    return { true_choice_id: choices[1].id, false_choice_id: choices[0].id };
  }
  if (secondIsFalse && !firstIsFalse) {
    return { true_choice_id: choices[0].id, false_choice_id: choices[1].id };
  }
  return { true_choice_id: choices[0].id, false_choice_id: choices[1].id };
}

function autoMapSurveyToConfig(surveyId, collectorId, details) {
  if (!details || !Array.isArray(details.pages) || details.pages.length === 0) {
    throw new Error('SurveyMonkey details missing pages');
  }

  const questions = [];

  for (const page of details.pages) {
    if (!page.questions || !Array.isArray(page.questions)) {
      continue;
    }
    for (const question of page.questions) {
      if (!question || !question.id) {
        continue;
      }
      const questionText = extractQuestionText(question);
      const family = String(question.family || '').toLowerCase();
      if (family === 'open_ended') {
          questions.push({
            question_id: question.id,
            page_id: page.id,
            question_text: questionText,
            type: 'text',
            inferred_intent: 'OPEN_FEEDBACK'
          });
        continue;
      }
      if (family === 'single_choice') {
        const choices = question.answers && Array.isArray(question.answers.choices)
          ? question.answers.choices
          : [];
        if (choices.length === 2) {
          const booleanChoices = resolveBooleanChoices(choices);
          if (!booleanChoices) {
            continue;
          }
          questions.push({
            question_id: question.id,
            page_id: page.id,
            question_text: questionText,
            type: 'boolean',
            true_choice_id: booleanChoices.true_choice_id,
            false_choice_id: booleanChoices.false_choice_id,
            inferred_intent: inferIntentFromText(questionText, 'boolean')
          });
        } else if (choices.length > 2) {
          const choiceMap = buildChoiceMap(choices);
          questions.push({
            question_id: question.id,
            page_id: page.id,
            question_text: questionText,
            type: 'scale',
            scale_min: choiceMap.min,
            scale_max: choiceMap.max,
            choice_ids: choiceMap.map,
            inferred_intent: inferIntentFromText(questionText, 'scale')
          });
        }
        continue;
      }
      if (family === 'matrix') {
        const choices = question.answers && Array.isArray(question.answers.choices)
          ? question.answers.choices
          : [];
        if (choices.length > 0) {
          const choiceMap = buildChoiceMap(choices);
          const rows = question.answers && Array.isArray(question.answers.rows)
            ? question.answers.rows
            : [];
          questions.push({
            question_id: question.id,
            page_id: page.id,
            question_text: questionText,
            type: 'scale',
            scale_min: choiceMap.min,
            scale_max: choiceMap.max,
            choice_ids: choiceMap.map,
            inferred_intent: inferIntentFromText(questionText, 'scale'),
            row_id: rows.length ? rows[0].id : undefined
          });
        }
      }
    }
  }

  return {
    survey_id: surveyId,
    collector_id: collectorId,
    page_id: details.pages[0].id,
    questions: questions
  };
}

// Submit response to SurveyMonkey API
async function submitSurveyMonkeyResponse(payload) {
  const token = payload.access_token || process.env.SURVEYMONKEY_ACCESS_TOKEN;
  if (!token) {
    return;
  }

  const config = payload.config;
  const surveyId = config.survey_id;
  const collectorId = config.collector_id;
  const pageId = config.page_id;
  if (!surveyId || !collectorId || !pageId) {
    throw new Error('SurveyMonkey config missing required IDs');
  }

  const pages = buildSurveyPagesPayload(payload.analysis, config);
  if (!pages.length) {
    return;
  }

  const body = {
    response_status: 'completed',
    pages: pages
  };

  console.log('[survey] payload:', JSON.stringify(body, null, 2));
  const response = await fetch('https://api.surveymonkey.com/v3/collectors/' + collectorId + '/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    console.error('[survey] error:', response.status, text);
    throw new Error('SurveyMonkey error: ' + text);
  }
  console.log('[survey] status:', response.status);
}

module.exports = { app };

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('InvisInsights API listening on ' + port);
});
