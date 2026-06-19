'use strict';
// Member login step 2 — verify the OTP code, issue a 30-day session token.

const crypto = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const j = (c, o) => ({ statusCode: c, headers: CORS, body: JSON.stringify(o) });
const sbH = (extra = {}) => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return j(405, { error: 'POST only' });

  let b; try { b = JSON.parse(event.body || '{}'); } catch { return j(400, { error: 'Invalid JSON' }); }
  const email = (b.email || '').trim().toLowerCase();
  const code  = (b.code || '').trim();
  const state = (b.state || '').trim().toUpperCase();
  if (!email || !/^\d{6}$/.test(code)) return j(400, { error: 'Enter the 6-digit code.' });

  const nowIso = new Date().toISOString();
  const cr = await fetch(`${SUPABASE_URL}/rest/v1/state_login_codes?email=eq.${encodeURIComponent(email)}&code=eq.${encodeURIComponent(code)}&expires_at=gt.${encodeURIComponent(nowIso)}&order=created_at.desc&limit=1`, { headers: sbH() });
  const codes = await cr.json();
  if (!Array.isArray(codes) || !codes.length) return j(401, { error: 'That code is invalid or expired.' });

  const token = 'ses_' + crypto.randomUUID().replace(/-/g, '');
  const session_expires_at = new Date(Date.now() + 30 * 86400000).toISOString();
  const stateClause = (state === 'NV' || state === 'CA') ? `&state=eq.${state}` : '';
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?email=eq.${encodeURIComponent(email)}&status=eq.active${stateClause}`, {
    method: 'PATCH', headers: sbH({ Prefer: 'return=representation' }),
    body: JSON.stringify({ session_token: token, session_expires_at }),
  });
  const subs = await pr.json();
  if (!Array.isArray(subs) || !subs.length) return j(403, { error: 'No active subscription found for that email.' });

  // burn the codes for this email
  await fetch(`${SUPABASE_URL}/rest/v1/state_login_codes?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE', headers: sbH({ Prefer: 'return=minimal' }) });

  return j(200, { ok: true, token, state: subs[0].state });
};
