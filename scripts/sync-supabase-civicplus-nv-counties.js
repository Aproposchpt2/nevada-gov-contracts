'use strict';
/* Syncs civicplus-nv-counties.json into state_contract_opportunities.
   Same ingestion pattern as sync-supabase-washoe.js / sync-supabase-
   nevadaepro.js: identity-reuse via apie_contract_identity, clobber-
   avoidance for rows already package-advanced.

   Unlike Washoe, real document URLs ARE available at scrape time here
   (confirmed live 2026-08-21 -- CivicPlus DocumentCenter links are plain
   public PDFs, no login), so document_urls is populated directly and
   package_status reflects that immediately instead of starting every row
   at PACKAGE_NOT_STARTED. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = 'state_contract_opportunities';
const SOURCE_PLATFORM = 'civicplus_nv_county';
const BATCH_SIZE = 200;

function sbHeaders(extra) {
  return Object.assign({ apikey: SERVICE_KEY, authorization: 'Bearer ' + SERVICE_KEY, 'content-type': 'application/json' }, extra || {});
}
function readJson(file) {
  const p = path.join(__dirname, '..', file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function parseDeadline(raw) {
  // "9/17/2029 10:00 AM" or "9/7/2026 4:00 PM" -- M/D/YYYY h:mm AM/PM, Pacific.
  const m = String(raw || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let [, mo, d, y, h, min, ap] = m;
  h = parseInt(h, 10);
  if (/pm/i.test(ap) && h !== 12) h += 12;
  if (/am/i.test(ap) && h === 12) h = 0;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${String(h).padStart(2, '0')}:${min}:00-07:00`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}
function buildRequirements(b) {
  const scope = (b.description || b.title || '').trim();
  if (scope.length < 20) return null;
  return { scope, source: 'civicplus_bid_listing_description' };
}
function fromBid(b) {
  const deadline = parseDeadline(b.closes);
  const status = String(b.status || '').toLowerCase();
  const isOpen = status === 'open';
  const documentUrls = (b.documents || []).map((d) => d.url);
  return {
    state_code: 'NV',
    jurisdiction_type: 'local',
    jurisdiction_name: b.jurisdiction_name,
    issuing_organization: b.jurisdiction_name,
    source_platform: SOURCE_PLATFORM,
    source_record_id: `${b.county.toLowerCase().replace(/\s+/g, '_')}_${b.bid_id}`,
    source_url: b.detail_url,
    solicitation_number: b.bid_id,
    title: b.title || null,
    description: b.description || b.title || null,
    notice_type: null,
    status: isOpen ? 'open' : status || 'closed',
    response_deadline: deadline,
    posted_at: null,
    place_of_performance_city: b.city || null,
    place_of_performance_county: b.county,
    place_of_performance_state: 'NV',
    document_urls: documentUrls,
    package_status: documentUrls.length ? 'PACKAGE_DISCOVERED' : 'PACKAGE_NOT_STARTED',
    package_document_count: documentUrls.length,
    requirements: buildRequirements(b),
    acquisition_method: 'official_public_civicplus_bids_aspx_portal',
    extraction_confidence: documentUrls.length ? 0.7 : 0.6,
    data_quality_score: documentUrls.length ? 65 : 55,
    qa_status: 'incomplete',
    qa_notes: documentUrls.length
      ? 'List + detail-page record: real document links captured at scrape time from the CivicPlus bid detail page, not yet downloaded/stored into contract_package_documents.'
      : 'List + detail-page record: no attached documents found on the bid detail page at scrape time.',
    raw_source_payload: b,
  };
}
async function fetchExistingIdentities() {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/apie_contract_identity?source_platform=eq.' + SOURCE_PLATFORM + '&select=id,source_record_id', { headers: sbHeaders() });
    if (!res.ok) return {};
    const rows = await res.json().catch(() => []);
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach((r) => { if (r.source_record_id) map[r.source_record_id] = r.id; });
    return map;
  } catch { return {}; }
}
async function fetchAdvancedPackageIds(ids) {
  if (!ids.length) return new Set();
  const advanced = new Set();
  const idList = ids.map((id) => '"' + id + '"').join(',');
  for (const [table, idCol] of [['state_contract_opportunities', 'id'], ['apie_contract_processing', 'opportunity_id']]) {
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + idCol + '=in.(' + idList + ')&package_status=in.(PACKAGE_COMPLETE,PACKAGE_PARTIAL)&select=' + idCol, { headers: sbHeaders() });
      if (!res.ok) continue;
      const rows = await res.json().catch(() => []);
      (Array.isArray(rows) ? rows : []).forEach((r) => advanced.add(r[idCol]));
    } catch { /* non-fatal */ }
  }
  return advanced;
}
async function upsertBatch(rows) {
  if (!rows.length) return { ok: 0, failed: 0 };
  let ok = 0, failed = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/' + TABLE + '?on_conflict=source_platform,source_record_id', { method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(chunk) });
      if (!res.ok) { const body = await res.text().catch(() => ''); console.log('[sync-supabase-civicplus-nv-counties] batch upsert FAILED (' + res.status + '): ' + body.slice(0, 400)); failed += chunk.length; }
      else ok += chunk.length;
    } catch (e) { console.log('[sync-supabase-civicplus-nv-counties] batch upsert error:', e.message); failed += chunk.length; }
  }
  return { ok, failed };
}
async function closeExpired() {
  const nowIso = new Date().toISOString();
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + TABLE + '?source_platform=eq.' + SOURCE_PLATFORM + '&status=neq.closed&response_deadline=lt.' + encodeURIComponent(nowIso), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ status: 'closed', closed_at: nowIso }) });
    if (!res.ok) return 0;
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch { return 0; }
}
async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) { console.log('[sync-supabase-civicplus-nv-counties] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping.'); return; }
  const data = readJson('civicplus-nv-counties.json');
  if (!data || !Array.isArray(data.bids) || !data.bids.length) { console.log('[sync-supabase-civicplus-nv-counties] No civicplus-nv-counties.json bids found — nothing to sync.'); return; }

  const identityMap = await fetchExistingIdentities();
  const rows = data.bids.map(fromBid).map((r) => ({ ...r, id: identityMap[r.source_record_id] || crypto.randomUUID() }));
  console.log('[sync-supabase-civicplus-nv-counties] ' + rows.length + ' bids mapped across counties');

  const advancedIds = await fetchAdvancedPackageIds(Object.values(identityMap));
  const freshRows = [], advancedRows = [];
  for (const r of rows) {
    if (advancedIds.has(r.id)) { const { package_status, package_document_count, package_completed_at, ...rest } = r; advancedRows.push(rest); }
    else freshRows.push(r);
  }
  console.log('[sync-supabase-civicplus-nv-counties] ' + advancedRows.length + ' row(s) already package-advanced -- upserting without touching package_status.');

  const freshResult = await upsertBatch(freshRows);
  const advancedResult = await upsertBatch(advancedRows);
  console.log('[sync-supabase-civicplus-nv-counties] upserted ' + (freshResult.ok + advancedResult.ok) + ' row(s), ' + (freshResult.failed + advancedResult.failed) + ' failed, into ' + TABLE + '.');

  const closed = await closeExpired();
  console.log('[sync-supabase-civicplus-nv-counties] marked ' + closed + ' row(s) closed (response_deadline passed).');
}
main().catch((e) => { console.error('[sync-supabase-civicplus-nv-counties] FAILED:', e.message); process.exit(0); });
