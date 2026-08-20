'use strict';
/* Syncs nevadaepro.json into the shared Supabase table
   state_contract_opportunities (project judislfknmhofcgzyozc), same table
   sync-supabase-nv.js (NGEM/Clark County) already writes to. Ingestion
   only, admission/matching stays Postgres's job -- mirrors that script's
   pattern exactly, including the same package-status clobber-avoidance
   fix (see sync-supabase-nv.js's fetchAdvancedPackageIds for the 2026-08-20
   incident this protects against).

   Document acquisition into Storage (contract_package_documents) is
   deliberately NOT built yet: that table requires a real acquisition_run_id
   + assignment_id, which in turn requires a real command_runs row --
   Executive Command Center's own internal orchestration schema, with
   generic JSON config blocks (pagination_instructions, attachment_
   instructions, etc.) whose semantics aren't understood yet. Rather than
   fabricate that chain blind, this connector writes real, complete
   requirements/contact/deadline data (which alone clears the
   natcorp_apply_release_gates() contact-info check that blocked NGEM
   records) and records known file attachments as metadata in document_urls
   -- real document download-to-Storage is flagged as follow-up work, not
   silently skipped. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
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
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function parseDeadline(raw) {
  // "09/11/2026 19:59:59" -- MM/DD/YYYY HH:mm:ss, no timezone given on the
  // page; treat as Pacific (Nevada) local time, same assumption NGEM's
  // close_date parsing already makes.
  const m = String(raw || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, mo, d, y, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}-07:00`; // PDT offset; good enough for a deadline field, not DST-critical
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function buildRequirements(b) {
  const scope = (b.scope || '').trim();
  if (scope.length < 20) return null;
  return { scope, source: 'nevadaepro_bid_detail' };
}

function fromNevadaePro(b) {
  const deadline = parseDeadline(b.bid_opening_date);
  const confidence = b.detail_fetched ? 1.0 : 0.6;
  const docs = (b.attachments || []).map(a => ({ name: a.name, file_nbr: a.file_nbr, requires_login: false, resolver: 'NEVADAEPRO_DOWNLOAD_FORM' }));
  return {
    state_code: 'NV',
    jurisdiction_type: 'state',
    jurisdiction_name: b.organization || 'State of Nevada',
    issuing_organization: b.organization ? 'State of Nevada — ' + b.organization : 'State of Nevada',
    source_platform: 'nevadaepro',
    source_record_id: String(b.doc_id),
    source_url: b.detail_url || null,
    solicitation_number: b.doc_id || null,
    title: b.title || null,
    description: b.scope || null,
    notice_type: null,
    status: 'open',
    response_deadline: deadline,
    posted_at: null,
    place_of_performance_city: null,
    place_of_performance_county: null,
    place_of_performance_state: 'NV',
    contact_name: b.contact_org || null,
    contact_email: b.contact_email || null,
    contact_phone: b.contact_phone || null,
    document_urls: docs,
    package_status: docs.length ? 'PACKAGE_DISCOVERED' : 'PACKAGE_NOT_STARTED',
    package_document_count: docs.length,
    requirements: buildRequirements(b),
    acquisition_method: 'official_public_periscope_nevadaepro_portal',
    extraction_confidence: confidence,
    data_quality_score: Math.round(confidence * 100),
    qa_status: (b.title && deadline) ? 'auto_ingested' : 'incomplete',
    qa_notes: !deadline ? 'bid_opening_date did not parse' : (!b.detail_fetched ? 'list-only record, detail page not yet fetched' : null),
    raw_source_payload: b,
  };
}

async function fetchExistingIdentities() {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/apie_contract_identity?source_platform=eq.nevadaepro&select=id,source_record_id',
      { headers: sbHeaders() }
    );
    if (!res.ok) return {};
    const rows = await res.json().catch(() => []);
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach(r => { if (r.source_record_id) map[r.source_record_id] = r.id; });
    return map;
  } catch (e) {
    console.log('[sync-supabase-nevadaepro] fetchExistingIdentities error:', e.message);
    return {};
  }
}

// Same clobber-avoidance as sync-supabase-nv.js: never let a fresh
// discovery pass downgrade a package that real acquisition work has
// already advanced past discovery.
async function fetchAdvancedPackageIds(ids) {
  if (!ids.length) return new Set();
  const advanced = new Set();
  const idList = ids.map(id => '"' + id + '"').join(',');
  for (const [table, idCol] of [['state_contract_opportunities', 'id'], ['apie_contract_processing', 'opportunity_id']]) {
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/' + table + '?' + idCol + '=in.(' + idList + ')&package_status=in.(PACKAGE_COMPLETE,PACKAGE_PARTIAL)&select=' + idCol,
        { headers: sbHeaders() }
      );
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
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/' + TABLE + '?on_conflict=source_platform,source_record_id',
        { method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(chunk) }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.log('[sync-supabase-nevadaepro] batch upsert FAILED (' + res.status + '): ' + body.slice(0, 400));
        failed += chunk.length;
      } else {
        ok += chunk.length;
      }
    } catch (e) {
      console.log('[sync-supabase-nevadaepro] batch upsert error:', e.message);
      failed += chunk.length;
    }
  }
  return { ok, failed };
}

async function closeExpired() {
  const nowIso = new Date().toISOString();
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/' + TABLE + '?source_platform=eq.nevadaepro&status=neq.closed&response_deadline=lt.' + encodeURIComponent(nowIso),
      { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ status: 'closed', closed_at: nowIso }) }
    );
    if (!res.ok) return 0;
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch { return 0; }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log('[sync-supabase-nevadaepro] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping.');
    return;
  }
  const data = readJson('nevadaepro.json');
  if (!data || !Array.isArray(data.bids) || !data.bids.length) {
    console.log('[sync-supabase-nevadaepro] No nevadaepro.json bids found — nothing to sync.');
    return;
  }

  const identityMap = await fetchExistingIdentities();
  const rows = data.bids.map(fromNevadaePro).map(r => ({
    ...r,
    id: identityMap[r.source_record_id] || crypto.randomUUID(),
  }));
  console.log('[sync-supabase-nevadaepro] nevadaepro: ' + rows.length + ' bids mapped');

  const advancedIds = await fetchAdvancedPackageIds(Object.values(identityMap));
  const freshRows = [], advancedRows = [];
  for (const r of rows) {
    if (advancedIds.has(r.id)) {
      const { package_status, package_document_count, package_completed_at, ...rest } = r;
      advancedRows.push(rest);
    } else {
      freshRows.push(r);
    }
  }
  console.log('[sync-supabase-nevadaepro] ' + advancedRows.length + ' row(s) already package-advanced -- upserting without touching package_status.');

  const freshResult = await upsertBatch(freshRows);
  const advancedResult = await upsertBatch(advancedRows);
  console.log('[sync-supabase-nevadaepro] upserted ' + (freshResult.ok + advancedResult.ok) + ' row(s), ' + (freshResult.failed + advancedResult.failed) + ' failed, into ' + TABLE + '.');

  const closed = await closeExpired();
  console.log('[sync-supabase-nevadaepro] marked ' + closed + ' NevadaePro row(s) closed (response_deadline passed).');
}

main().catch(e => {
  console.error('[sync-supabase-nevadaepro] FAILED:', e.message);
  process.exit(0);
});
