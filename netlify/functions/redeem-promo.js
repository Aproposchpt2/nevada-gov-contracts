// redeem-promo.js
// Validates a NevadaStateGen promo code and provisions a 30-day free trial.
// POST { email, code, business_name?, state? }
// Returns { ok, session_token, trial_end, message }
'use strict';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.RESEND_FROM_EMAIL || 'no-reply@aproposgroupllc.com';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const sbH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' });

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH() });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : null;
}

function genToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let t = 'ses_';
  for (let i = 0; i < 40; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = (body.email || '').trim().toLowerCase();
  const code  = (body.code  || '').trim().toUpperCase();
  const biz   = (body.business_name || '').trim();
  const state = (body.state || 'NV').toUpperCase();

  console.log('[redeem-promo] SUPABASE_URL prefix:', SUPABASE_URL.slice(0, 10));
  if (!SUPABASE_URL || !SUPABASE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error.' }) };
  if (!SUPABASE_URL.startsWith('http')) return { statusCode: 500, headers, body: JSON.stringify({ error: 'SUPABASE_URL missing https prefix.' }) };
  if (!email || !code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email and promo code required.' }) };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email address.' }) };

  // Validate promo code
  const promo = await sbGet(`nevada_promo_codes?code=eq.${encodeURIComponent(code)}&active=eq.true&limit=1`);
  if (!promo) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invalid or expired promo code. Please check and try again.' }) };
  if (promo.uses_count >= promo.uses_allowed) return { statusCode: 410, headers, body: JSON.stringify({ error: 'This promo code has reached its maximum usage. Please contact support.' }) };
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) return { statusCode: 410, headers, body: JSON.stringify({ error: 'This promo code has expired.' }) };

  // Check if already has an active subscription or trial
  const existing = await sbGet(`state_alert_subscribers?email=eq.${encodeURIComponent(email)}&state=eq.${encodeURIComponent(state)}&limit=1`);
  if (existing && existing.status === 'active' && !existing.trial_end) {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'This email already has an active subscription. Please log in instead.', login: true }) };
  }

  // Calculate trial window
  const trialDays = promo.trial_days || 30;
  const trialEnd  = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString();
  const sessionExpiry = trialEnd; // session lasts for the trial duration
  const sessionToken  = genToken();

  // Upsert subscriber with trial
  const subData = {
    email, state,
    business_name: biz || existing?.business_name || '',
    status: 'active',
    comp: false,
    trial_end: trialEnd,
    promo_code: code,
    session_token: sessionToken,
    session_expires_at: sessionExpiry,
    alerts_opt_in: true,
    alert_cadence: 'weekday',
    alert_days: [1, 2, 3, 4, 5],
    keywords: [],
    updated_at: new Date().toISOString(),
  };

  await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?on_conflict=email,state`, {
    method: 'POST',
    headers: { ...sbH(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(subData)
  });

  // Increment promo code usage
  await fetch(`${SUPABASE_URL}/rest/v1/nevada_promo_codes?code=eq.${encodeURIComponent(code)}`, {
    method: 'PATCH',
    headers: { ...sbH(), Prefer: 'return=minimal' },
    body: JSON.stringify({ uses_count: promo.uses_count + 1 })
  });

  // Send welcome email via Resend
  if (RESEND_KEY) {
    const trialEndFmt = new Date(trialEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `NV Gov Contracts Center <${FROM_EMAIL}>`,
        to: [email],
        subject: 'Your 30-day free access to Nevada State Government Contracts Center is ready',
        text: `Welcome to Nevada State Government Contracts Center!\n\nYour ${trialDays}-day free trial is active through ${trialEndFmt}.\n\nAccess your dashboard here:\nhttps://nvgovcc.aproposgroupllc.com/dashboard.html\n\nYour login email: ${email}\n\nNeed help? Reply to this email.\n\n— Apropos Group LLC`
      })
    }).catch(() => {});
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      session_token: sessionToken,
      trial_end: trialEnd,
      trial_days: trialDays,
      message: `Your ${trialDays}-day free trial is active. Welcome!`
    })
  };
};
