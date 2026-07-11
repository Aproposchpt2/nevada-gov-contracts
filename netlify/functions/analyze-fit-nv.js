'use strict';
// Nevada Bid Analyze Fit — Claude AI agent
// POST { bid, profile }
// Returns { score, recommendation, reasoning, requirements, risks }

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const j = (c, o) => ({ statusCode: c, headers: CORS, body: JSON.stringify(o) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
  if (!ANTHROPIC_KEY) return j(500, { error: 'AI service not configured.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return j(400, { error: 'Invalid JSON' }); }

  const { bid = {}, profile = {} } = body;
  if (!bid.title) return j(400, { error: 'Bid title required.' });

  const businessName = profile.business_name || 'Apropos Group LLC';
  const services = (profile.commodity_codes || []).length > 0
    ? profile.commodity_codes.join(', ')
    : (profile.keywords || []).join(', ') || 'Technology, Software Development, IT Services, Computer Networking';

  const prompt = `You are a Nevada government contract specialist helping ${businessName} evaluate a bid opportunity.

BUSINESS PROFILE:
- Company: ${businessName}
- Registered services/commodities: ${services}
- State: Nevada

BID OPPORTUNITY:
- Title: ${bid.title}
- Agency: ${bid.agency || 'Nevada State Agency'}
- Type: ${bid.bid_type || 'Bid'}
- Solicitation #: ${bid.solicitation_no || 'N/A'}
- Days remaining: ${bid.due_in_days != null ? bid.due_in_days + ' days' : 'Open'}
- Status: ${bid.status || 'Issued'}${bid.description ? '\n- Scope of Work: ' + bid.description.slice(0, 800) : ''}

Analyze this bid for ${businessName} and respond in this exact JSON format:
{
  "score": <number 0-100 representing match percentage>,
  "recommendation": "<GO | REVIEW | NO-GO>",
  "summary": "<one sentence verdict>",
  "strengths": ["<strength 1>", "<strength 2>"],
  "risks": ["<risk 1>", "<risk 2>"],
  "requirements": ["<key requirement 1>", "<key requirement 2>"],
  "next_steps": "<what to do immediately if pursuing this bid>"
}

Be direct and practical. Base the score on how well the business services match the bid requirements.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      return j(502, { error: 'AI service error: ' + res.status, detail: err.slice(0, 200) });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';

    // Extract JSON from response
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return j(500, { error: 'Could not parse AI response.', raw: text.slice(0, 300) });

    const analysis = JSON.parse(match[0]);
    return j(200, { ok: true, analysis });

  } catch (e) {
    return j(500, { error: e.message });
  }
};
