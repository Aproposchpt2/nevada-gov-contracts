'use strict';
/* Syncs washoe.json into state_contract_opportunities. Same pattern as
   sync-supabase-nevadaepro.js: ingestion only, same clobber-avoidance
   fix, same identity-reuse via apie_contract_identity.

   v1 is list-level only (see scrape-washoe.js): requirements.scope is
   the listing title itself, honestly noted as list-only in qa_notes --
   not a substitute for the real RFP description a future detail-page
   fetch (__doPostBack) would provide. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = 'state_contract_opportunities';
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
  const m = String(raw || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, mo, d, y] = m;
  const dt = new Date(`${y}-${mo}-${d}T17:00:00-07:00`); // no time-of-day on this site; assume 5pm Pacific
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}
function buildRequirements(s) {
  const scope = (s.title || '').trim();
  if (scope.length < 20) return null;
  return { scope, source: 'washoe_wcsd_listing_title' };
}
function fromWashoe(s) {
  const deadline = parseDeadline(s.due_date);
  const isOpen = String(s.status || '').toLowerCase() === 'active';
  return {
    state_code: 'NV',
    jurisdiction_type: 'local',
    jurisdiction_name: 'Washoe County School District',
    issuing_organization: 'Washoe County School District',
    source_platform: 'washoe_wcsd',
    source_record_id: s.project_number,
    source_url: 'https://solicitations.washoeschools.net/Purchasing',
    solicitation_number: s.project_number,
    title: s.title || null,
    description: s.title || null,
    notice_type: s.project_type || null,
    status: isOpen ? 'open' : 'closed',
    response_deadline: deadline,
    posted_at: null,
    place_of_performance_city: 'Reno',
    place_of_performance_county: 'Washoe',
    place_of_performance_state: 'NV',
    document_urls: [],
    package_status: 'PACKAGE_NOT_STARTED',
    package_document_count: 0,
    requirements: buildRequirements(s),
    acquisition_method: 'official_public_washoe_wcsd_solicitations_portal',
    extraction_confidence: 0.6,
    data_quality_score: 60,
    qa_status: 'incomplete',
    qa_notes: 'List-only record: title used as scope text, full RFP description not yet fetched (detail view is an ASP.NET __doPostBack, not yet built).',
    raw_source_payload: s,
  };
}
async function fetchExistingIdentities() {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/apie_contract_identity?source_platform=eq.washoe_wcsd&select=id,source_record_id', { headers: sbHeaders() });
    if (!res.ok) return {};
    const rows = await res.json().catch(() => []);
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach(r => { if (r.source_record_id) map[r.source_record_id] = r.id; });
    return map;
  } catch { return {}; }
}
async function fetchAdvancedPackageIds(ids) {
  if (!ids.length) return new Set();
  const advanced = new Set();
  const idList = ids.map(id => '"' + id + '"').join(',');
  for (const [table, idCol] of [['state_contract_opportunities', 'id'], ['apie_contract_processing', 'opportunity_id']]) {
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + idCol + '=in.(' + idList + ')&package_status=in.(PACKAGE_COMPLETE,PACKAGE_PARTIAL)&select=' + idCol, { headers: sbHeaders() });
      if (!res.ok) continue;
      const rows = await res.json().catch(() => []);
      (Array.isArray(rows) ? rows : []).forEach(r => advanced.add(r[idCol]));
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
      if (!res.ok) { const body = await res.text().catch(() => ''); console.log('[sync-supabase-washoe] batch upsert FAILED (' + res.status + '): ' + body.slice(0, 400)); failed += chunk.length; }
      else ok += chunk.length;
    } catch (e) { console.log('[sync-supabase-washoe] batch upsert error:', e.message); failed += chunk.length; }
  }
  return { ok, failed };
}
async function closeExpired() {
  const nowIso = new Date().toISOString();
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + TABLE + '?source_platform=eq.washoe_wcsd&status=neq.closed&response_deadline=lt.' + encodeURIComponent(nowIso), { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ status: 'closed', closed_at: nowIso }) });
    if (!res.ok) return 0;
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch { return 0; }
}
async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) { console.log('[sync-supabase-washoe] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping.'); return; }
  const data = readJson('washoe.json');
  if (!data || !Array.isArray(data.solicitations) || !data.solicitations.length) { console.log('[sync-supabase-washoe] No washoe.json solicitations found — nothing to sync.'); return; }

  const identityMap = await fetchExistingIdentities();
  const rows = data.solicitations.map(fromWashoe).map(r => ({ ...r, id: identityMap[r.source_record_id] || crypto.randomUUID() }));
  console.log('[sync-supabase-washoe] washoe: ' + rows.length + ' solicitations mapped');

  const advancedIds = await fetchAdvancedPackageIds(Object.values(identityMap));
  const freshRows = [], advancedRows = [];
  for (const r of rows) {
    if (advancedIds.has(r.id)) { const { package_status, package_document_count, package_completed_at, ...rest } = r; advancedRows.push(rest); }
    else freshRows.push(r);
  }
  console.log('[sync-supabase-washoe] ' + advancedRows.length + ' row(s) already package-advanced -- upserting without touching package_status.');

  const freshResult = await upsertBatch(freshRows);
  const advancedResult = await upsertBatch(advancedRows);
  console.log('[sync-supabase-washoe] upserted ' + (freshResult.ok + advancedResult.ok) + ' row(s), ' + (freshResult.failed + advancedResult.failed) + ' failed, into ' + TABLE + '.');

  const closed = await closeExpired();
  console.log('[sync-supabase-washoe] marked ' + closed + ' Washoe row(s) closed (response_deadline passed).');
}
main().catch(e => { console.error('[sync-supabase-washoe] FAILED:', e.message); process.exit(0); });
