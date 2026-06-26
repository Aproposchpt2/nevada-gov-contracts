'use strict';
// Member login step 1 — email a 6-digit OTP code to an active StateGen subscriber.
// Also accepts activated Apropos Business Center members and provisions the state dashboard record on first OTP request.

const DEFAULT_SUPABASE_URL = 'https://judislfknmhofcgzyozc.supabase.co';
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.BC_SUPA_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.BC_SUPA_KEY || '';
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM         = process.env.RESEND_FROM_EMAIL || 'StateGen <jmitchell@aproposgroupllc.com>';

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const j = (c, o) => ({ statusCode: c, headers: CORS, body: JSON.stringify(o) });
const sbH = (extra = {}) => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra });

function memberIsActive(member) {
  const status = String(member.subscription_status || '').toLowerCase();
  if (['active', 'trial', 'trialing', 'paid', 'comp'].includes(status)) return true;
  const trialEnd = member.trial_end ? Date.parse(member.trial_end) : 0;
  return Number.isFinite(trialEnd) && trialEnd > Date.now();
}

function keywordsFromMember(member) {
  const industry = String(member.industry || '').trim();
  if (!industry) return [];
  return Array.from(new Set(industry.split(/[,&/|]+/).map(x => x.trim()).filter(Boolean).slice(0, 8)));
}

async function getActiveStateSubscriber(email, state) {
  const stateClause = (state === 'NV' || state === 'CA') ? `&state=eq.${state}` : '';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?email=eq.${encodeURIComponent(email)}&status=eq.active${stateClause}&select=email,business_name&limit=1`, { headers: sbH() });
  const rows = await r.json().catch(() => []);
  if (Array.isArray(rows) && rows.length) return rows[0];
  return null;
}

async function getActivatedBusinessCenterMember(email) {
  const select = 'email,full_name,business_name,industry,city,state,subscription_status,trial_end,bc_access_activated';
  const url = `${SUPABASE_URL}/rest/v1/biz_center_members?email=eq.${encodeURIComponent(email)}&bc_access_activated=eq.true&select=${encodeURIComponent(select)}&limit=1`;
  const r = await fetch(url, { headers: sbH() });
  const rows = await r.json().catch(() => []);
  if (!r.ok || !Array.isArray(rows) || !rows.length) return null;
  return memberIsActive(rows[0]) ? rows[0] : null;
}

async function provisionStateSubscriberFromBusinessCenter(member, state) {
  if (!(state === 'NV' || state === 'CA')) return null;

  const email = String(member.email || '').toLowerCase();
  const businessName = member.business_name || 'Business Center Member';
  const payload = {
    email,
    business_name: businessName,
    state,
    status: 'active',
    comp: true,
    keywords: keywordsFromMember(member),
  };

  const existingUrl = `${SUPABASE_URL}/rest/v1/state_alert_subscribers?email=eq.${encodeURIComponent(email)}&state=eq.${state}&select=email,state&limit=1`;
  const existing = await fetch(existingUrl, { headers: sbH() }).then(r => r.json()).catch(() => []);

  if (Array.isArray(existing) && existing.length) {
    await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?email=eq.${encodeURIComponent(email)}&state=eq.${state}`, {
      method: 'PATCH',
      headers: sbH({ Prefer: 'return=minimal' }),
      body: JSON.stringify(payload),
    });
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers`, {
      method: 'POST',
      headers: sbH({ Prefer: 'return=minimal' }),
      body: JSON.stringify(payload),
    });
  }

  return { email, business_name: businessName };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return j(405, { error: 'POST only' });
  if (!SERVICE_KEY) return j(500, { error: 'Supabase service key is not configured.' });

  let b; try { b = JSON.parse(event.body || '{}'); } catch { return j(400, { error: 'Invalid JSON' }); }
  const email = (b.email || '').trim().toLowerCase();
  const state = (b.state || '').trim().toUpperCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return j(400, { error: 'A valid email is required.' });

  let subscriber = await getActiveStateSubscriber(email, state);

  // Business Center members activate once at AIBizCenter. After activation, they use this same OTP login.
  if (!subscriber) {
    const bcMember = await getActivatedBusinessCenterMember(email);
    if (bcMember) subscriber = await provisionStateSubscriberFromBusinessCenter(bcMember, state);
  }

  if (!subscriber) return j(200, { ok: true, found: false });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires_at = new Date(Date.now() + 10 * 60000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/state_login_codes`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify({ email, state: state || null, code, expires_at }) });

  const html = `<div style="background:#0F2A6A;padding:34px 16px;font-family:Arial,sans-serif"><div style="max-width:460px;margin:0 auto;background:#11264f;border:1px solid #1c3878;border-radius:8px;padding:32px;text-align:center">
    <div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9DB0D4;margin-bottom:14px">StateGen · Member Login</div>
    <p style="color:#9DB0D4;font-size:14px;margin:0 0 18px">Your login code:</p>
    <div style="font-size:34px;letter-spacing:.32em;font-weight:700;color:#fff;background:#07111f;border:2px solid #6EE7A8;border-radius:10px;padding:18px;margin-bottom:18px">${code}</div>
    <p style="color:#9DB0D4;font-size:13px;line-height:1.6">Enter this code to access your dashboard. It expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
    <p style="color:#3a5470;font-size:11px;margin-top:20px">A service of Apropos Group LLC</p></div></div>`;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: FROM, to: [email], subject: `Your StateGen login code: ${code}`, html }) });
  } catch (e) { console.error('[send-login-code]', e.message); }

  return j(200, { ok: true, found: true });
};
