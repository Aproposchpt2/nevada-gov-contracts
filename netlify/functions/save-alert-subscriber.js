'use strict';
// Save/update a StateGen bid-alert subscriber (email + state + keywords).
// Reached after Stripe checkout (Payment Link success redirect → /alerts.html).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = (body.email || '').trim().toLowerCase();
  const state = (body.state || '').trim().toUpperCase();
  let keywords = Array.isArray(body.keywords) ? body.keywords : String(body.keywords || '').split(',');
  keywords = keywords.map(k => String(k).trim().toLowerCase()).filter(Boolean).slice(0, 15);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'A valid email is required.' }) };
  if (state !== 'NV' && state !== 'CA')
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'State must be NV or CA.' }) };
  if (!keywords.length)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Add at least one keyword.' }) };

  // Upsert on (email, state) — re-saving updates the keyword set.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?on_conflict=email,state`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ email, state, keywords, status: 'active', updated_at: new Date().toISOString() }),
  });

  if (!res.ok) {
    console.error('[save-alert-subscriber]', await res.text());
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not save. Please try again.' }) };
  }
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, state, count: keywords.length }) };
};
