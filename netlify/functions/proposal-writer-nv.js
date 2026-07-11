'use strict';
// Nevada Bid Proposal Writer — Claude AI agent
// POST { bid, business, services }
// Returns { ok, proposal }

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

  const { bid = {}, business = 'Apropos Group LLC', services = 'Technology, Software Development, IT Services' } = body;
  if (!bid.title) return j(400, { error: 'Bid title required.' });

  const prompt = `You are a professional Nevada government contract proposal writer. Write a compelling, professional proposal response for the following opportunity.

COMPANY: ${business}
CORE SERVICES: ${services}

BID OPPORTUNITY:
- Title: ${bid.title}
- Issuing Agency: ${bid.agency || 'Nevada State Agency'}
- Solicitation #: ${bid.solicitation_no || 'N/A'}
- Type: ${bid.bid_type || 'Bid'}${bid.description ? '\n- Scope of Work: ' + bid.description.slice(0, 800) : ''}

Write a complete proposal draft with these sections:
## Executive Summary
## Understanding of Requirements
## Proposed Approach & Solution
## Relevant Experience & Qualifications
## Project Team & Key Personnel
## Why Choose ${business}
## Conclusion

Keep it professional, Nevada government-appropriate, and tailored to the specific bid. Use "we" and reference ${business} by name. Mark any placeholder information with [PLACEHOLDER] so the team knows to customize it.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      return j(502, { error: 'AI service error: ' + res.status, detail: err.slice(0, 200) });
    }

    const data = await res.json();
    const proposal = data.content?.[0]?.text || '';
    if (!proposal) return j(500, { error: 'Empty response from AI.' });

    return j(200, { ok: true, proposal });

  } catch (e) {
    return j(500, { error: e.message });
  }
};
