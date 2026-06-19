'use strict';
// Verify a Stripe Checkout Session is a real PAID subscription before we let someone
// turn on alerts. Returns the email + state (NV/CA) derived from the purchased price.

const STRIPE_KEY      = process.env.STRIPE_SECRET_KEY;            // live (sk_live_…)
const STRIPE_KEY_TEST = process.env.STRIPE_SECRET_KEY_TEST || ''; // sandbox (sk_test_…)

const PRICE_STATE = {
  'price_1TjlNbBMRgYNYb8DRybCz0gQ': 'NV', // NevadaStateGen Monthly (live)
  'price_1TjlMlBMRgYNYb8DY0MrAi5E': 'CA', // CalStateGen Monthly (live)
  'price_1Tk5jLB1NkJ0LaTof15m7ckL': 'NV', // NevadaStateGen Monthly (TEST/sandbox)
};

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let LAST_ERR = null; // safe health-probe data (no secret values)
async function getSession(id) {
  // test sessions (cs_test_…) must be read with the test key; everything else uses live
  const isTest = id.startsWith('cs_test_');
  const key = isTest ? (STRIPE_KEY_TEST || STRIPE_KEY) : STRIPE_KEY;
  const r = await fetch(
    'https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(id) + '?expand[]=line_items',
    { headers: { Authorization: 'Bearer ' + key } }
  );
  if (!r.ok) {
    let code = '';
    try { const e = await r.json(); code = (e.error && (e.error.code || e.error.type)) || ''; } catch {}
    LAST_ERR = { http: r.status, code, keyMode: isTest ? 'test' : 'live' };
    return null;
  }
  return r.json();
}

function evalSession(s) {
  if (!s) return { valid: false, error: 'We couldn\'t find that checkout session.' };
  const complete = s.status === 'complete';
  const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
  if (!complete || !paid || s.mode !== 'subscription')
    return { valid: false, error: 'No active subscription found on this checkout.' };
  const li = s.line_items && s.line_items.data && s.line_items.data[0];
  const priceId = li && li.price && li.price.id;
  const state = PRICE_STATE[priceId] || null;
  const email = (s.customer_details && s.customer_details.email) || s.customer_email || null;
  if (!state || !email) return { valid: false, error: 'Could not read your subscription details.' };
  return { valid: true, email, state, customer: s.customer || null, subscription: s.subscription || null };
}

exports.PRICE_STATE = PRICE_STATE;
exports.getSession = getSession;
exports.evalSession = evalSession;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!STRIPE_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Stripe not configured.' }) };
  const sid = ((event.queryStringParameters || {}).session_id || '').trim();
  if (!sid.startsWith('cs_')) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing session_id.' }) };
  const debug = ((event.queryStringParameters || {}).debug === '1');
  LAST_ERR = null;
  const v = evalSession(await getSession(sid));
  if (!v.valid) {
    const body = { error: v.error };
    if (debug) body.stripe = LAST_ERR; // {http, code, keyMode} — no secrets
    return { statusCode: 403, headers: CORS, body: JSON.stringify(body) };
  }
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, email: v.email, state: v.state }) };
};
