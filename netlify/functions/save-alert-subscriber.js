'use strict';
// Onboarding / profile save — HARD-GATED.
// Path A: a verified Stripe session (new subscriber) → save business name, keywords,
//   alert opt-in; email + state come from the PAYMENT; issues a 30-day session token so
//   they land straight in their dashboard.
// Path B: a returning subscriber's token → update their profile.

const crypto = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const { getSession, evalSession } = require('./verify-checkout-session');

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const j = (c, o) => ({ statusCode: c, headers: CORS, body: JSON.stringify(o) });
const sbH = (extra = {}) => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra });
const cleanKeywords = k => (Array.isArray(k) ? k : String(k || '').split(',')).map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 15);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return j(405, { error: 'POST only' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return j(400, { error: 'Invalid JSON' }); }
  const keywords      = cleanKeywords(body.keywords);
  const business_name = (body.business_name || '').trim() || null;
  const alerts_opt_in = body.alerts_opt_in !== false; // default true unless explicitly false
  const VALID_CAD     = ['off','weekly','weekday','custom'];
  const alert_cadence = VALID_CAD.includes(body.alert_cadence) ? body.alert_cadence : null;
  const alert_days    = Array.isArray(body.alert_days) ? [...new Set(body.alert_days.map(Number).filter(d => d>=0 && d<=6))] : null;
  if (!keywords.length) return j(400, { error: 'Add at least one keyword.' });

  // Shared profile patch for returning subscribers (Path B/C)
  const buildPatch = () => {
    const p = { keywords, status: 'active', updated_at: new Date().toISOString() };
    if (business_name) p.business_name = business_name;
    if ('alerts_opt_in' in body) p.alerts_opt_in = alerts_opt_in;
    if (alert_cadence) p.alert_cadence = alert_cadence;
    if (alert_days) p.alert_days = alert_days;
    return p;
  };

  const sessionId = (body.session_id || '').trim(); // Stripe checkout (cs_)
  const token     = (body.token || '').trim();      // subscriber manage token
  const session   = (body.session || '').trim();    // dashboard session (ses_)

  // ── Path A: new subscriber via verified Stripe session ──────────────
  if (sessionId) {
    if (!sessionId.startsWith('cs_')) return j(400, { error: 'Invalid checkout session.' });
    const v = evalSession(await getSession(sessionId));
    if (!v.valid) return j(403, { error: v.error || 'A paid subscription is required.' });

    const session = 'ses_' + crypto.randomUUID().replace(/-/g, '');
    const session_expires_at = new Date(Date.now() + 30 * 86400000).toISOString();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?on_conflict=email,state`, {
      method: 'POST',
      headers: sbH({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({
        email: v.email, state: v.state, keywords, business_name, alerts_opt_in, status: 'active',
        stripe_customer_id: v.customer, stripe_subscription_id: v.subscription,
        session_token: session, session_expires_at, updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) { console.error('[save-alert]', await res.text()); return j(500, { error: 'Could not save. Please try again.' }); }
    return j(200, { ok: true, state: v.state, email: v.email, count: keywords.length, session });
  }

  // ── Path B: returning subscriber updating profile via manage token ─
  if (token) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?token=eq.${encodeURIComponent(token)}`, {
      method: 'PATCH', headers: sbH({ Prefer: 'return=representation' }), body: JSON.stringify(buildPatch()),
    });
    if (!res.ok) { console.error('[save-alert]', await res.text()); return j(500, { error: 'Could not save. Please try again.' }); }
    const rows = await res.json();
    if (!rows || !rows.length) return j(404, { error: 'We couldn\'t find that profile.' });
    return j(200, { ok: true, state: rows[0].state, count: keywords.length });
  }

  // ── Path C: logged-in member updating from the dashboard (session) ─
  if (session.startsWith('ses_')) {
    const nowIso = new Date().toISOString();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?session_token=eq.${encodeURIComponent(session)}&session_expires_at=gt.${encodeURIComponent(nowIso)}`, {
      method: 'PATCH', headers: sbH({ Prefer: 'return=representation' }), body: JSON.stringify(buildPatch()),
    });
    if (!res.ok) { console.error('[save-alert]', await res.text()); return j(500, { error: 'Could not save. Please try again.' }); }
    const rows = await res.json();
    if (!rows || !rows.length) return j(401, { error: 'Your session expired. Please log in again.' });
    return j(200, { ok: true, state: rows[0].state, count: keywords.length });
  }

  return j(403, { error: 'A paid subscription is required.' });
};
