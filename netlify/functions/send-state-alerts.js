// StateGen — daily bid-alert emailer (the paid-tier value).
// Pulls each state's current bids, matches them to every active subscriber's keywords,
// emails the NEW matches (deduped via state_alert_sent), records what was sent.
// Opt-in/transactional — subscribers asked for this. Sent via Resend.

export const config = { schedule: "@daily" };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM         = process.env.RESEND_FROM_EMAIL || 'StateGen <jmitchell@aproposgroupllc.com>';

const SOURCES = {
  NV: { name: 'Nevada',     site: 'https://nevadastategen.aproposgroupllc.com', bids: 'https://nevadastategen.aproposgroupllc.com/.netlify/functions/ngem-pipeline' },
  CA: { name: 'California', site: 'https://calstategen.aproposgroupllc.com',    bids: 'https://calstategen.aproposgroupllc.com/bids.json' },
};

function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}
async function bidsFor(state) {
  try { const r = await fetch(SOURCES[state].bids); const j = await r.json(); return Array.isArray(j.bids) ? j.bids : []; }
  catch { return []; }
}
function isMatch(bid, keywords) {
  const hay = `${bid.title || ''} ${bid.agency || ''} ${bid.bid_type || ''}`.toLowerCase();
  return keywords.some(k => hay.includes(k));
}
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendAlert(sub, newBids) {
  const S = SOURCES[sub.state];
  const rows = newBids.slice(0, 15).map(b =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #1c3878">
      <a href="${esc(b.url || S.site)}" style="color:#fff;font-weight:600;text-decoration:none;font-size:15px">${esc(b.title)}</a>
      <div style="color:#9DB0D4;font-size:12.5px;margin-top:3px">${esc(b.agency)}${b.due_in_days != null ? ' &middot; closes in ' + b.due_in_days + ' days' : ''}${b.solicitation_no ? ' &middot; ' + esc(b.solicitation_no) : ''}</div>
    </td></tr>`).join('');
  const noun = newBids.length === 1 ? 'bid matches' : 'bids match';
  const html = `<div style="background:#0F2A6A;padding:34px 16px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:540px;margin:0 auto;background:#11264f;border:1px solid #1c3878;border-radius:8px;padding:30px 32px">
      <div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9DB0D4;margin-bottom:10px">${S.name} StateGen &middot; Bid Alert</div>
      <h2 style="color:#fff;font-weight:400;font-size:22px;margin:0 0 6px">${newBids.length} new ${S.name} ${noun} your business</h2>
      <p style="color:#9DB0D4;font-size:13.5px;margin:0 0 20px">Matched to your keywords: <strong style="color:#C3D0E8">${esc((sub.keywords || []).join(', '))}</strong></p>
      <table style="width:100%;border-collapse:collapse">${rows}</table>
      <a href="${S.site}" style="display:inline-block;margin-top:24px;background:#fff;color:#0F2A6A;font-weight:700;text-decoration:none;padding:13px 24px;border-radius:4px;font-size:12px;letter-spacing:.14em;text-transform:uppercase">Open the bid board &rarr;</a>
      <p style="color:#5a6f9c;font-size:11px;line-height:1.6;margin-top:24px">You're receiving this because you subscribed to ${S.name} StateGen bid alerts. A service of Apropos Group LLC.</p>
    </div></div>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [sub.email], subject: `${newBids.length} new ${S.name} ${noun} your business`, html }),
  });
}

export default async function handler() {
  const subs = await (await sb('state_alert_subscribers?status=eq.active&select=id,email,state,keywords')).json();
  const bidCache = {};
  let emailed = 0, totalNew = 0;

  for (const sub of (Array.isArray(subs) ? subs : [])) {
    if (!sub.keywords || !sub.keywords.length || !SOURCES[sub.state]) continue;
    if (!bidCache[sub.state]) bidCache[sub.state] = await bidsFor(sub.state);

    const matched = bidCache[sub.state].filter(b => isMatch(b, sub.keywords));
    if (!matched.length) continue;

    const sentRows = await (await sb(`state_alert_sent?subscriber_id=eq.${sub.id}&select=bid_id`)).json();
    const already = new Set((Array.isArray(sentRows) ? sentRows : []).map(x => String(x.bid_id)));
    const fresh = matched.filter(b => !already.has(String(b.id)));
    if (!fresh.length) continue;

    await sendAlert(sub, fresh);
    await sb('state_alert_sent', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify(fresh.map(b => ({ subscriber_id: sub.id, bid_id: String(b.id) }))),
    });
    emailed++; totalNew += fresh.length;
  }

  return new Response(JSON.stringify({ ok: true, subscribers: (subs || []).length, emailed, newBids: totalNew }, null, 2),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
}
