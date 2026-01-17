setTimeout(() => {
  // What is keeping the process alive?
  const handles = process._getActiveHandles();
  const requests = process._getActiveRequests();

  console.log('[debug] active handles:', handles.map(h => h?.constructor?.name));
  console.log('[debug] active requests:', requests.map(r => r?.constructor?.name));
}, 2000);


console.log('[boot] start');

console.time('require express');
const express = require('express');
console.timeEnd('require express');
console.log('[boot] after require express');

console.time('init app');
const app = express();
console.timeEnd('init app');
console.log('[boot] after app init');

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

const sessions = [];

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

  if (process.env.AUTO_ANALYZE === 'true') {
    try {
      const analysis = await runOpenRouterAnalysis(session);
      console.log('[analyze] result:', JSON.stringify(analysis, null, 2));
    } catch (err) {
      // Keep /collect resilient; analysis can be run async or separately.
    }
  }

  return res.json({ ok: true });
});

// POST /analyze
app.post('/analyze', async (req, res) => {
  const session = req.body;
  if (!session || !session.session_id) {
    return res.status(400).json({ error: 'missing session_id' });
  }

  try {
    const analysis = await runOpenRouterAnalysis(session);
    const surveyMetrics = mapToSurveyMetrics(analysis);

    if (process.env.SURVEYMONKEY_ACCESS_TOKEN && process.env.SURVEYMONKEY_SURVEY_ID) {
      await submitSurveyMonkeyResponse({
        session_id: session.session_id,
        survey_id: process.env.SURVEYMONKEY_SURVEY_ID,
        analysis: analysis,
        derived_metrics: surveyMetrics
      });
    }

    return res.json({ analysis, survey_metrics: surveyMetrics });
  } catch (err) {
    return res.status(500).json({ error: 'analysis_failed', detail: err.message });
  }
});

function buildOpenRouterPrompt(session) {
  return (
    'You are a UX analytics assistant. Interpret the session summary as behavioral signals.' +
    '\n' +
    'Return ONLY valid JSON with the specified fields.' +
    '\n' +
    'Use probabilistic language (likely, suggests, indicates). Avoid absolute claims.' +
    '\n\n' +
    'Session summary JSON:\n' +
    JSON.stringify(session, null, 2) +
    '\n\n' +
    'Required JSON output schema:\n' +
    '{\n' +
    '  "ux_clarity_score": number (0-100),\n' +
    '  "frustration_level": number (0-100),\n' +
    '  "navigation_intuitiveness": number (0-100),\n' +
    '  "confidence": {\n' +
    '    "ux_clarity": number (0-1),\n' +
    '    "frustration": number (0-1),\n' +
    '    "navigation": number (0-1),\n' +
    '    "abandonment": number (0-1)\n' +
    '  },\n' +
    '  "inferences": {\n' +
    '    "ui_confusion": { "summary": string, "signals": string[] },\n' +
    '    "navigation_difficulty": { "summary": string, "signals": string[] },\n' +
    '    "user_frustration": { "summary": string, "signals": string[] },\n' +
    '    "trust_confidence_issues": { "summary": string, "signals": string[] },\n' +
    '    "likely_abandonment_reason": { "summary": string, "signals": string[] }\n' +
    '  },\n' +
    '  "actionable_suggestions": string[]\n' +
    '}'
  );
}

// Run OpenRouter analysis
async function runOpenRouterAnalysis(session) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set');
  }

  const prompt = buildOpenRouterPrompt(session);
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

function mapToSurveyMetrics(analysis) {
  if (!analysis) {
    return null;
  }
  var frustration = analysis.frustration_level || 0;
  var clarity = analysis.ux_clarity_score || 0;
  var nav = analysis.navigation_intuitiveness || 0;

  var csat = Math.max(1, Math.min(5, Math.round((clarity + nav) / 40)));
  var nps = Math.max(0, Math.min(10, Math.round((clarity - frustration) / 10)));

  return {
    inferred_csat_1_to_5: csat,
    inferred_nps_0_to_10: nps,
    inferred_confusion_flag: clarity < 55,
    inferred_frustration_flag: frustration > 60,
    inferred_open_text: analysis.inferences && analysis.inferences.ui_confusion
      ? analysis.inferences.ui_confusion.summary
      : 'No strong confusion signals.'
  };
}

function deriveSurveyAnswers(analysis) {
  const metrics = mapToSurveyMetrics(analysis);
  if (!metrics) {
    return null;
  }
  return {
    csat: metrics.inferred_csat_1_to_5,
    nps: metrics.inferred_nps_0_to_10,
    confusion: metrics.inferred_confusion_flag,
    improve_text: metrics.inferred_open_text || ''
  };
}

function parseChoiceMap(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

// Submit response to SurveyMonkey API
async function submitSurveyMonkeyResponse(payload) {
  const token = process.env.SURVEYMONKEY_ACCESS_TOKEN;
  if (!token) {
    return;
  }

  const collectorId = process.env.SURVEYMONKEY_COLLECTOR_ID;
  const pageId = process.env.SURVEYMONKEY_PAGE_ID;
  const csatQuestionId = process.env.SURVEYMONKEY_CSAT_QUESTION_ID;
  const npsQuestionId = process.env.SURVEYMONKEY_NPS_QUESTION_ID;
  const npsRowId = process.env.SURVEYMONKEY_NPS_ROW_ID;
  const confusionQuestionId = process.env.SURVEYMONKEY_CONFUSION_QUESTION_ID;
  const improveQuestionId = process.env.SURVEYMONKEY_IMPROVE_QUESTION_ID;
  const csatChoiceMap = parseChoiceMap(process.env.SURVEYMONKEY_CSAT_CHOICE_IDS);
  const npsChoiceMap = parseChoiceMap(process.env.SURVEYMONKEY_NPS_CHOICE_IDS);
  const confusionYesChoiceId = process.env.SURVEYMONKEY_CONFUSION_CHOICE_ID_YES;
  const confusionNoChoiceId = process.env.SURVEYMONKEY_CONFUSION_CHOICE_ID_NO;

  if (!collectorId || !pageId || !csatQuestionId || !npsQuestionId || !npsRowId || !confusionQuestionId || !improveQuestionId) {
    throw new Error('SurveyMonkey question/page IDs not set');
  }

  const answers = deriveSurveyAnswers(payload.analysis);
  if (!answers) {
    return;
  }

  const csatChoiceId = csatChoiceMap ? csatChoiceMap[String(answers.csat)] : null;
  const npsChoiceId = npsChoiceMap ? npsChoiceMap[String(answers.nps)] : null;
  const confusionChoiceId = answers.confusion ? confusionYesChoiceId : confusionNoChoiceId;

  if (!csatChoiceId || !npsChoiceId || !confusionChoiceId) {
    throw new Error('SurveyMonkey choice IDs not set for derived answers');
  }

  const body = {
    response_status: 'completed',
    pages: [
      {
        id: pageId,
        questions: [
          { id: csatQuestionId, answers: [{ choice_id: csatChoiceId }] },
          { id: npsQuestionId, answers: [{ row_id: npsRowId, choice_id: npsChoiceId }] },
          { id: confusionQuestionId, answers: [{ choice_id: confusionChoiceId }] },
          { id: improveQuestionId, answers: [{ text: answers.improve_text }] }
        ]
      }
    ],
    custom_variables: {
      inferred: 'true',
      source: 'invisinsights',
      session_id: payload.session_id
    }
  };

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
    throw new Error('SurveyMonkey error: ' + text);
  }
}

module.exports = { app };

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('InvisInsights API listening on ' + port);
});
