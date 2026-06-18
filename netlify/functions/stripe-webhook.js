'use strict';
// Stripe webhook — subscription lifecycle for StateGen bid alerts.
// On cancellation/non-payment, flip the subscriber's status so the daily matcher
// stops emailing them; reactivation flips it back. Matched by stripe_subscription_id.

const crypto = require('crypto');

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Verify the Stripe-Signature header (HMAC-SHA256 of `${t}.${rawBody}`).
function verifySignature(rawBody, sigHeader) {
  if (!WEBHOOK_SECRET || !sigHeader) return false;
  const parts = {};
  sigHeader.split(',').forEach(kv => { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) return false; // 5-min tolerance
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function setStatusBySubscription(subId, status) {
  if (!subId) return;
  await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?stripe_subscription_id=eq.${encodeURIComponent(subId)}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const sig = (event.headers && (event.headers['stripe-signature'] || event.headers['Stripe-Signature'])) || '';
  if (!verifySignature(raw, sig)) return { statusCode: 400, body: 'Invalid signature' };

  let evt;
  try { evt = JSON.parse(raw); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const obj = (evt.data && evt.data.object) || {};
  const DEAD = ['canceled', 'unpaid', 'incomplete_expired'];

  try {
    if (evt.type === 'customer.subscription.deleted') {
      await setStatusBySubscription(obj.id, 'canceled');
    } else if (evt.type === 'customer.subscription.updated') {
      if (DEAD.includes(obj.status)) await setStatusBySubscription(obj.id, 'canceled');
      else if (obj.status === 'active') await setStatusBySubscription(obj.id, 'active');
      // cancel_at_period_end=true is still 'active' until the period ends → leave active.
    }
  } catch (e) {
    console.error('[stripe-webhook]', e.message);
    // 200 anyway so Stripe doesn't hammer retries on a transient DB blip.
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
