'use strict';
// Logged-in member → a Stripe Billing Portal session (update card, view invoices, cancel).
// Auth by dashboard session token. No card data ever touches us — Stripe hosts it.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STRIPE_KEY   = process.env.STRIPE_SECRET_KEY;

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const j = (c, o) => ({ statusCode: c, headers: CORS, body: JSON.stringify(o) });
const sbH = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return j(405, { error: 'POST only' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return j(400, { error: 'Invalid JSON' }); }
  const session    = (body.session || '').trim();
  const return_url = (body.return_url || '').trim() || 'https://nevadastategen.aproposgroupllc.com/dashboard.html';
  if (!session.startsWith('ses_')) return j(400, { error: 'Missing session.' });
  if (!STRIPE_KEY) return j(500, { error: 'Billing is not configured.' });

  // resolve the member's Stripe customer from their valid session
  const nowIso = new Date().toISOString();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?session_token=eq.${encodeURIComponent(session)}&session_expires_at=gt.${encodeURIComponent(nowIso)}&select=stripe_customer_id&limit=1`, { headers: sbH() });
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return j(401, { error: 'Your session expired. Please log in again.' });
  const customer = rows[0].stripe_customer_id;
  if (!customer) return j(400, { error: 'No billing account is linked to your subscription yet.' });

  // create the Stripe Billing Portal session
  const form = new URLSearchParams({ customer, return_url });
  const sres = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const sdata = await sres.json();
  if (!sres.ok) { console.error('[billing-portal]', JSON.stringify(sdata)); return j(502, { error: (sdata.error && sdata.error.message) || 'Could not open billing.' }); }
  return j(200, { ok: true, url: sdata.url });
};
