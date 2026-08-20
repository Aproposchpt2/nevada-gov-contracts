'use strict';
/* Seeds acquisition_raw_records for NV/NGEM bids that sync-supabase-nv.js has
   already placed in the canonical tables (state_contract_opportunities /
   apie_contract_processing) but that acquire-ngem-documents.js can't see yet.

   Real gap found live 2026-08-20: acquisition_raw_records is a separate table
   from the canonical ones, requiring a real acquisition_run_id + assignment_id
   (both NOT NULL FKs) -- normally owned by the Executive Command Center's
   own M2M publisher-discovery flow. NGEM was seeded into it manually in an
   earlier session using one fixed run/assignment pair, but nothing kept that
   seed in sync with ongoing weekly discovery -- new bids kept landing in the
   canonical tables while acquisition_raw_records stayed frozen at its
   original 12 rows, so acquire-ngem-documents.js never saw them.

   This reuses that same existing, still-RUNNING acquisition_run_id/
   assignment_id (confirmed valid via FK + status check, not fabricated) --
   deliberately not creating new orchestration entities, since those belong
   to the Command Center system and its invariants aren't fully understood
   yet. Should run right after sync-supabase-nv.js, on the same schedule. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

// Existing, verified-valid (status=RUNNING) run/assignment pair every current
// NV acquisition_raw_records row already uses -- see acquire-ngem-documents.js
// header comment and the 2026-08-20 investigation for provenance.
const ACQUISITION_RUN_ID = 'c19be9f0-6db7-4117-b258-de0aa701a2fa';
const ASSIGNMENT_ID = 'e1989800-410e-4da7-977e-f2edc9e945e5';
const PUBLISHER_ID = '15314e83-769c-4943-8b29-7312a8cd51d4';

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
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function fetchIdentityMap() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/apie_contract_identity?source_platform=eq.ngem&select=id,source_record_id',
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error('fetchIdentityMap failed (' + res.status + '): ' + (await res.text()).slice(0, 300));
  const rows = await res.json().catch(() => []);
  const map = {};
  (Array.isArray(rows) ? rows : []).forEach(r => { if (r.source_record_id) map[r.source_record_id] = r.id; });
  return map;
}

async function fetchAlreadySeeded() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/acquisition_raw_records?publisher_id=eq.' + PUBLISHER_ID + '&select=source_record_id',
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error('fetchAlreadySeeded failed (' + res.status + '): ' + (await res.text()).slice(0, 300));
  const rows = await res.json().catch(() => []);
  return new Set((Array.isArray(rows) ? rows : []).map(r => r.source_record_id));
}

function buildRow(bid, canonicalId) {
  const sourceRecordId = String(bid.bid_id || bid.id);
  const fingerprint = crypto.createHash('sha256').update(sourceRecordId + '|' + (bid.solicitation_no || '') + '|' + (bid.title || '')).digest('hex');
  return {
    acquisition_run_id: ACQUISITION_RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    publisher_id: PUBLISHER_ID,
    source_record_id: sourceRecordId,
    source_url: bid.url || 'https://nevada.ionwave.net/Login.aspx',
    raw_payload: {
      solicitation_number: bid.solicitation_no || null,
      title: bid.title || null,
      agency: bid.agency || null,
      close_date: bid.close_date || null,
    },
    source_fingerprint: fingerprint,
    content_fingerprint: fingerprint,
    canonical_opportunity_id: canonicalId,
    processing_status: 'RAW',
    package_status: 'PACKAGE_NOT_STARTED',
  };
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log('[seed-acquisition-raw-records] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set -- skipping.');
    return;
  }
  const ngem = readJson('ngem.json');
  if (!ngem || !Array.isArray(ngem.bids) || !ngem.bids.length) {
    console.log('[seed-acquisition-raw-records] No ngem.json bids found -- nothing to seed.');
    return;
  }

  const [identityMap, alreadySeeded] = await Promise.all([fetchIdentityMap(), fetchAlreadySeeded()]);

  const toSeed = [];
  for (const bid of ngem.bids) {
    const sourceRecordId = String(bid.bid_id || bid.id);
    if (alreadySeeded.has(sourceRecordId)) continue;
    const canonicalId = identityMap[sourceRecordId];
    if (!canonicalId) { console.log('[seed-acquisition-raw-records] no identity yet for', sourceRecordId, '-- skipping (sync-supabase-nv.js should run first).'); continue; }
    toSeed.push(buildRow(bid, canonicalId));
  }

  console.log('[seed-acquisition-raw-records] ' + ngem.bids.length + ' bid(s) in ngem.json, ' + alreadySeeded.size + ' already seeded, ' + toSeed.length + ' new to insert.');
  if (!toSeed.length) { console.log('[seed-acquisition-raw-records] nothing to do.'); return; }

  const res = await fetch(
    SUPABASE_URL + '/rest/v1/acquisition_raw_records',
    { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(toSeed) }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.log('[seed-acquisition-raw-records] insert FAILED (' + res.status + '): ' + body.slice(0, 500));
    process.exit(1);
  }
  console.log('[seed-acquisition-raw-records] inserted ' + toSeed.length + ' new acquisition_raw_records row(s).');
}

main().catch(e => {
  console.error('[seed-acquisition-raw-records] FAILED:', e.message);
  process.exit(0);
});
