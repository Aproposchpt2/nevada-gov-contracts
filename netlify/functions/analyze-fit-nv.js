'use strict';

const HEADERS = { 'Content-Type': 'application/json' };
const json = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

function promptFor(bid, profile) {
  const businessName = profile.business_name || profile.entity_name || 'the business';
  const services = Array.isArray(profile.keywords) && profile.keywords.length
    ? profile.keywords.join(', ')
    : Array.isArray(profile.commodity_codes) && profile.commodity_codes.length
      ? profile.commodity_codes.join(', ')
      : 'Not provided';
  const certifications = Array.isArray(profile.certifications) ? profile.certifications.join(', ') : 'Not provided';
  const days = bid.due_in_days ?? bid.daysToClose ?? 'Not provided';

  return `You are a senior Nevada public-procurement analyst. Evaluate this opportunity against the business profile. Do not invent facts. Prefix every material statement with one of: [Confirmed], [Business Profile], [Reasonable Inference], or [Requires Verification]. A confirmed mandatory eligibility failure must force recommendation PASS regardless of technical fit.

BUSINESS PROFILE
Business: ${businessName}
Services and keywords: ${services}
Certifications: ${certifications}
Nevada vendor status: ${profile.nevada_vendor_status || 'Not provided'}
Past performance: ${profile.past_performance || 'Not provided'}

OPPORTUNITY
Title: ${bid.title || 'Not provided'}
Agency: ${bid.agency || 'Nevada public agency'}
Solicitation number: ${bid.solicitation_no || bid.id || 'Not provided'}
Type: ${bid.bid_type || 'Not provided'}
Deadline / days remaining: ${bid.close_date || bid.deadline || days}
Commodity / category: ${bid.commodity_code || bid.category || 'Not provided'}
Status: ${bid.status || 'Issued'}
Description: ${(bid.description || '').slice(0, 4000) || 'Not provided'}

Return JSON only with this exact shape:
{
  "fitScore": 0,
  "recommendation": "PURSUE|REVIEW|PASS",
  "hardStop": false,
  "hardStopReason": "",
  "scores": {
    "capabilityMatch": 0,
    "industryAlignment": 0,
    "eligibility": 0,
    "pastPerformance": 0,
    "geography": 0,
    "proposalReadiness": 0,
    "deadlineReadiness": 0
  },
  "sections": {
    "s1": "Opportunity Summary",
    "s2": "Why This Opportunity Matched",
    "s3": "Eligibility Review",
    "s4": "Capability Match",
    "s5": "Bid / No-Bid Rationale",
    "s6": "Performance Requirements",
    "s7": "Staffing and Delivery Requirements",
    "s8": "Compliance Requirements",
    "s9": "Deadline Risk",
    "s10": "Pricing Considerations",
    "s11": "Draft Technical Approach",
    "s12": "Proposal Checklist",
    "s13": "Questions for the Contracting Officer",
    "s14": "Recommended Next Step"
  }
}

Scoring weights: capability 25%, industry 15%, eligibility 20%, past performance 15%, geography 10%, proposal readiness 10%, deadline readiness 5%. Keep each section practical and detailed, normally 2-5 sentences. For s12 and s13, use numbered items inside the string. Nevada-specific checks may include Nevada vendor registration, applicable licensing, prevailing wage, bonding, insurance, local delivery, required certifications, and agency-specific submission rules.`;
}

function normalize(raw) {
  const sections = raw.sections || {};
  const score = Math.max(0, Math.min(100, Math.round(Number(raw.fitScore ?? raw.score ?? 0))));
  let recommendation = String(raw.recommendation || 'REVIEW').toUpperCase();
  if (recommendation === 'GO' || recommendation === 'BID') recommendation = 'PURSUE';
  if (recommendation === 'NO-GO' || recommendation === 'NO_BID') recommendation = 'PASS';
  if (!['PURSUE', 'REVIEW', 'PASS'].includes(recommendation)) recommendation = 'REVIEW';
  if (raw.hardStop) recommendation = 'PASS';
  return {
    fitScore: score,
    recommendation,
    hardStop: Boolean(raw.hardStop),
    hardStopReason: String(raw.hardStopReason || ''),
    scores: raw.scores || {},
    sections: Object.fromEntries(Array.from({ length: 14 }, (_, i) => {
      const key = `s${i + 1}`;
      return [key, String(sections[key] || raw[key] || 'Information requires verification from the solicitation documents.')];
    }))
  };
}

function extractJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI response did not contain JSON.');
  return normalize(JSON.parse(match[0]));
}

async function analyzeWithOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0.1,
      max_tokens: 3500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return valid JSON only. Be conservative, evidence-aware, and procurement-compliance focused.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = await response.json();
  return extractJson(data.choices?.[0]?.message?.content || '');
}

async function analyzeWithAnthropic(prompt) {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured.');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 3500,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Anthropic ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = await response.json();
  return extractJson(data.content?.[0]?.text || '');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON request.' }); }

  const bid = body.bid || {};
  const profile = body.profile || {};
  if (!bid.title) return json(400, { ok: false, error: 'Bid title required.' });

  const prompt = promptFor(bid, profile);
  const failures = [];
  try {
    const analysis = await analyzeWithOpenAI(prompt);
    return json(200, { ok: true, provider: 'openai', analysis, bid, generatedAt: new Date().toISOString() });
  } catch (error) { failures.push(error.message); }

  try {
    const analysis = await analyzeWithAnthropic(prompt);
    return json(200, { ok: true, provider: 'anthropic-fallback', analysis, bid, generatedAt: new Date().toISOString() });
  } catch (error) { failures.push(error.message); }

  console.error('[analyze-fit-nv]', failures.join(' | '));
  return json(502, { ok: false, error: 'The analysis service could not complete the report.', detail: failures.join(' | ') });
};
