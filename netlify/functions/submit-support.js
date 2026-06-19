'use strict';
// Support request intake — stores the request and emails the owner.
// Open to members and visitors (CORS *). Best-effort; never blocks the user.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM         = process.env.RESEND_FROM_EMAIL || 'StateGen <jmitchell@aproposgroupllc.com>';
const SUPPORT_TO   = process.env.SUPPORT_TO_EMAIL || 'jmitchell@aproposgroupllc.com';

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const j = (c, o) => ({ statusCode: c, headers: CORS, body: JSON.stringify(o) });
const sbH = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' });
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => String(s || '').slice(0, n);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return j(405, { error: 'POST only' });

  let b; try { b = JSON.parse(event.body || '{}'); } catch { return j(400, { error: 'Invalid JSON' }); }
  const name = clip(b.name, 120).trim();
  const email = clip(b.email, 160).trim();
  const state = clip(b.state, 4).trim().toUpperCase();
  const category = clip(b.category, 60).trim() || 'General';
  const message = clip(b.message, 4000).trim();
  const business_name = clip(b.business_name, 160).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return j(400, { error: 'Please enter a valid email.' });
  if (!message) return j(400, { error: 'Please add a message.' });

  // store (best-effort)
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/state_support_requests`, {
      method: 'POST', headers: sbH(),
      body: JSON.stringify({ name, email, state, category, message, business_name }),
    });
  } catch (e) { console.error('[support] store', e); }

  // notify the owner (best-effort)
  if (RESEND_KEY) {
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">
      <h2 style="margin:0 0 10px">New support request${state ? ' · ' + esc(state) : ''}</h2>
      <p style="margin:2px 0"><b>Category:</b> ${esc(category)}</p>
      <p style="margin:2px 0"><b>From:</b> ${esc(name || '—')} &lt;${esc(email)}&gt;</p>
      ${business_name ? '<p style="margin:2px 0"><b>Business:</b> ' + esc(business_name) + '</p>' : ''}
      <hr style="border:none;border-top:1px solid #ddd;margin:14px 0">
      <p style="white-space:pre-wrap;line-height:1.6">${esc(message)}</p>
    </div>`;
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [SUPPORT_TO], reply_to: email, subject: `Support · ${category}${state ? ' · ' + state : ''} — ${name || email}`, html }),
      });
    } catch (e) { console.error('[support] email', e); }
  }

  return j(200, { ok: true });
};
