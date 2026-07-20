'use strict';
/* StateGen (NV) — sync ngem.json into the shared Supabase raw table
   `state_contract_opportunities` (project judislfknmhofcgzyozc, same project NGCC
   and CalGCC use). Mirrors CAL-GOV-CONTRACT-CENTER/scripts/sync-supabase.js:
   ingestion only, no criteria/filtering — that's Postgres's scope, not this
   script's. Upserts keyed on (source_platform, source_record_id); marks NV
   rows closed once response_deadline has passed. */

const fs = require('fs');
const path = require('path');

const DEFAULT_SUPABASE_URL = 'https://judislfknmhofcgzyozc.supabase.co';
const SUPABASE_URL = (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = 'state_contract_opportunities';
const BATCH_SIZE = 200;

function sbHeaders(extra) {
  return Object.assign({
    apikey: SERVICE_KEY,
    authorization: 'Bearer ' + SERVICE_KEY,
    'content-type': 'application/json',
  }, extra || {});
}

function readJson(file) {
  const p = path.join(__dirname, '..', file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function fromNgem(b) {
  return {
    state_code: 'NV',
    issuing_organization: b.agency || 'Nevada public agency',
    source_platform: 'ngem',
    source_record_id: String(b.bid_id || b.id),
    source_url: b.url || null,
    solicitation_number: b.solicitation_no || null,
    title: b.title,
    description: b.description || null,
    notice_type: b.bid_type || null,
    status: 'open',
    response_deadline: b.close_date || null,
    posted_at: null,
    place_of_performance_state: 'NV',
    contact_name: b.contact_name || null,
    contact_email: b.contact_email || null,
    contact_phone: b.contact_phone || null,
    document_urls: (b.documents || []).map(d => ({ name: d })),
    raw_source_payload: b,
  };
}

async function upsertBatch(rows) {
  if (!rows.length) return { ok: 0, failed: 0 };
  let ok = 0, failed = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/' + TABLE + '?on_conflict=source_platform,source_record_id',
        { method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(chunk) }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.log('[sync-supabase-nv] batch upsert FAILED (' + res.status + '): ' + body.slice(0, 400));
        failed += chunk.length;
      } else {
        ok += chunk.length;
      }
    } catch (e) {
      console.log('[sync-supabase-nv] batch upsert error:', e.message);
      failed += chunk.length;
    }
  }
  return { ok, failed };
}

async function closeExpired() {
  const nowIso = new Date().toISOString();
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/' + TABLE + '?state_code=eq.NV&status=neq.closed&response_deadline=lt.' + encodeURIComponent(nowIso),
      { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ status: 'closed', closed_at: nowIso }) }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.log('[sync-supabase-nv] close-expired FAILED (' + res.status + '): ' + body.slice(0, 400));
      return 0;
    }
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) {
    console.log('[sync-supabase-nv] close-expired error:', e.message);
    return 0;
  }
}

async function main() {
  if (!SERVICE_KEY) {
    console.log('[sync-supabase-nv] SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase sync (ngem.json is unaffected).');
    return;
  }

  const ngem = readJson('ngem.json');
  if (!ngem || !Array.isArray(ngem.bids) || !ngem.bids.length) {
    console.log('[sync-supabase-nv] No ngem.json bids found — nothing to sync.');
    return;
  }

  const rows = ngem.bids.map(fromNgem);
  console.log('[sync-supabase-nv] ngem: ' + rows.length + ' bids mapped');

  const { ok, failed } = await upsertBatch(rows);
  console.log('[sync-supabase-nv] upserted ' + ok + ' row(s), ' + failed + ' failed, into ' + TABLE + '.');

  const closed = await closeExpired();
  console.log('[sync-supabase-nv] marked ' + closed + ' NV row(s) closed (response_deadline passed).');
}

main().catch(e => {
  console.error('[sync-supabase-nv] FAILED:', e.message);
  process.exit(0);
});
