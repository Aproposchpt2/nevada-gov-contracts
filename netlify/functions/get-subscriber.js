'use strict';
// Validate a session token → return the subscriber's dashboard profile.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const j = (c, o) => ({ statusCode: c, headers: CORS, body: JSON.stringify(o) });
const sbH = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const token = ((event.queryStringParameters || {}).token || '').trim();
  if (!token.startsWith('ses_')) return j(400, { error: 'Missing session.' });

  const nowIso = new Date().toISOString();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?session_token=eq.${encodeURIComponent(token)}&session_expires_at=gt.${encodeURIComponent(nowIso)}&select=email,business_name,state,keywords,commodity_codes,alerts_opt_in,alert_cadence,alert_days,stripe_customer_id&limit=1`, { headers: sbH() });
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return j(401, { error: 'Your session expired. Please log in again.' });
  const s = rows[0];
  return j(200, {
    ok: true, email: s.email, business_name: s.business_name, state: s.state,
    keywords: s.keywords || [],
    commodity_codes: s.commodity_codes || [],
    alerts_opt_in: s.alerts_opt_in,
    alert_cadence: s.alert_cadence || 'off',
    alert_days: s.alert_days || [],
    has_billing: !!s.stripe_customer_id,
  });
};
