'use strict';
/* StateGen (NV) — sync ngem.json into the shared Supabase raw table
   `state_contract_opportunities` (project judislfknmhofcgzyozc, same project NGCC
   and CalGCC use). Mirrors CAL-GOV-CONTRACT-CENTER/scripts/sync-supabase.js:
   ingestion only, no criteria/filtering — that's Postgres's scope, not this
   script's. Upserts keyed on (source_platform, source_record_id); marks NV
   rows closed once response_deadline has passed. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// No hardcoded fallback URL here on purpose -- Netlify's secret scanner
// flags any literal string in the repo matching a configured secret env
// var's value. This broke calgovcc's build the same way; fixing here
// proactively before nvgovcc's next build hits it too.
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
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// Clark County / Las Vegas metro agencies seen live in ngem.json (2026-08-15
// scoping pass) -- county government itself, its departments/districts, and
// every incorporated city inside the county. Matched case-insensitively;
// the regex fallback catches any "Clark County ..." variant not spelled out
// here (e.g. a new CC department that starts posting later).
const CLARK_AGENCIES = new Set([
  'clark county, nevada',
  'clark county school district',
  'clark county school district purchasing',
  'clark county water reclamation district',
  'clark county department of aviation',
  'cc dept of aviation',
  'city of las vegas, nevada',
  'city of las vegas',
  'city of henderson',
  'city of north las vegas',
  'boulder city, nevada',
  'boulder city',
  'las vegas valley water district',
  'las vegas convention & visitors authority',
  'las vegas metropolitan police department',
  'las vegas metropolitan police',
  'lvmpd',
  'university medical center',
]);
function isClarkCounty(agency) {
  const a = (agency || '').trim().toLowerCase();
  if (!a) return false;
  return CLARK_AGENCIES.has(a) || /clark county|las vegas metropolitan/.test(a);
}

// NGEM is dominated by cities/counties/districts/higher-ed -- true state-level
// executive-branch postings are the exception here, not the rule. Only agency
// names that explicitly self-identify as the state are marked 'state'; every
// other real agency name is 'local' (city/county/district/authority).
function jurisdictionType(agency) {
  return /^(state of nevada|nevada department|nevada division|purchasing division)/i.test((agency || '').trim())
    ? 'state' : 'local';
}

// Admission guard on state_contract_opportunities (natcorp_canonical_contract_
// admission_guard_trg) silently drops any row whose `requirements` isn't
// substantive real content -- confirmed live via natcorp_contract_rejection_
// ledger (every NGEM row was being rejected, reason
// missing_substantive_contract_requirements, because this field was never
// populated). Mirrors the shape CA's PUBLIC_PORTAL rows already use:
// {scope: <real description text>, source: <provenance>}. Left null (not a
// placeholder) when there's no real description yet -- a list-only record
// with zero real content SHOULD fail the gate, that's it working correctly,
// not a bug to route around.
function buildRequirements(b) {
  const scope = (b.description || '').trim();
  if (scope.length < 20) return null;
  return { scope, source: 'ngem_public_detail' };
}

function fromNgem(b) {
  const deadline = b.close_date || null;
  // detail_fetched means the PublicDetail.aspx popup parse actually returned
  // a description -- known to fail often (Ionwave's label markup varies by
  // bid, see scrape-ngem.js's detail-fetch failure rate) so list-only rows
  // are common and genuinely lower-confidence, not a bug to hide.
  const confidence = b.detail_fetched ? 1.0 : 0.6;
  const clark = isClarkCounty(b.agency);
  // documents is normally the new {name, description, file_size,
  // requires_login} shape (scrape-ngem.js rgBidAttachments fix, 2026-08-16);
  // defensively also accept the old plain-string shape until the self-heal
  // re-fetch cycle (see scrape-ngem.js needDetail) has cycled through every
  // cached bid. requires_login=true on every real NGEM attachment confirmed
  // live -- the file itself needs the same vendor login Bonfire does, so
  // this is discovery, not a completed package: PACKAGE_DISCOVERED, not
  // PACKAGE_COMPLETE.
  const docs = (b.documents || []).map(d => (typeof d === 'string' ? { name: d } : d)).filter(d => d && d.name);
  const packageStatus = docs.length ? 'PACKAGE_DISCOVERED' : 'PACKAGE_NOT_STARTED';
  return {
    state_code: 'NV',
    jurisdiction_type: jurisdictionType(b.agency),
    jurisdiction_name: b.agency || null,
    issuing_organization: b.agency || 'Nevada public agency',
    source_platform: 'ngem',
    source_record_id: String(b.bid_id || b.id),
    source_url: b.url || null,
    solicitation_number: b.solicitation_no || null,
    title: b.title,
    description: b.description || null,
    notice_type: b.bid_type || null,
    status: 'open',
    response_deadline: deadline,
    posted_at: null,
    place_of_performance_city: null,
    place_of_performance_county: clark ? 'Clark' : null,
    place_of_performance_state: 'NV',
    contact_name: b.contact_name || null,
    contact_email: b.contact_email || null,
    contact_phone: b.contact_phone || null,
    document_urls: docs,
    package_status: packageStatus,
    package_document_count: docs.length,
    requirements: buildRequirements(b),
    acquisition_method: 'official_public_ionwave_marketplace',
    extraction_confidence: confidence,
    data_quality_score: Math.round(confidence * 100),
    qa_status: (b.title && deadline) ? 'auto_ingested' : 'incomplete',
    qa_notes: !deadline ? 'close_date did not parse from source close_date_raw value'
      : (!b.detail_fetched ? 'list-only record, detail popup not yet fetched' : null),
    raw_source_payload: b,
  };
}

// A row that gets admitted but isn't yet PACKAGE_COMPLETE gets relocated out
// of state_contract_opportunities into apie_contract_processing by
// apie_sync_contract_lifecycle_projection (it DELETEs the state_contract_
// opportunities row after moving it -- by design, that's how the LIVE/
// PROCESSING/ARCHIVE funnel works). The next sync then has no existing row
// to upsert-merge against, so PostgREST inserts fresh with a brand-new
// auto-generated id -- which collides with apie_contract_identity's own
// UNIQUE(source_platform, source_record_id) from the row's first pass
// (confirmed live: 23505 on apie_contract_identity_source_platform_source_
// record_id_key). Reusing the identity table's already-issued id keeps a
// source record on the same id across that funnel instead of colliding.
async function fetchExistingIdentities() {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/apie_contract_identity?source_platform=eq.ngem&select=id,source_record_id',
      { headers: sbHeaders() }
    );
    if (!res.ok) return {};
    const rows = await res.json().catch(() => []);
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach(r => { if (r.source_record_id) map[r.source_record_id] = r.id; });
    return map;
  } catch (e) {
    console.log('[sync-supabase-nv] fetchExistingIdentities error:', e.message);
    return {};
  }
}

// Real acquisition work (acquire-ngem-documents.js) advances package_status
// past discovery (PACKAGE_COMPLETE/PACKAGE_PARTIAL) independently of this
// weekly discovery re-sync. Confirmed live 2026-08-20: this sync always
// recomputed packageStatus fresh from ngem.json's document *discovery* list
// (see fromNgem), so the next scheduled run after real acquisition progress
// silently reset already-completed packages back down to PACKAGE_DISCOVERED/
// PACKAGE_NOT_STARTED -- undoing real work. A row can live in either
// state_contract_opportunities or apie_contract_processing (the LIVE/
// PROCESSING funnel relocates it), so check both.
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
      if (!res.ok) { console.log('[sync-supabase-nv] fetchAdvancedPackageIds(' + table + ') FAILED (' + res.status + ')'); continue; }
      const rows = await res.json().catch(() => []);
      (Array.isArray(rows) ? rows : []).forEach(r => advanced.add(r[idCol]));
    } catch (e) {
      console.log('[sync-supabase-nv] fetchAdvancedPackageIds(' + table + ') error:', e.message);
    }
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
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log('[sync-supabase-nv] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase sync (ngem.json is unaffected).');
    return;
  }

  const ngem = readJson('ngem.json');
  if (!ngem || !Array.isArray(ngem.bids) || !ngem.bids.length) {
    console.log('[sync-supabase-nv] No ngem.json bids found — nothing to sync.');
    return;
  }

  const identityMap = await fetchExistingIdentities();
  // PostgREST bulk insert requires every object in the array to have the
  // same key set (PGRST102 "All object keys must match" -- confirmed live
  // when id was only present on some rows). Always include id explicitly:
  // reuse the existing apie_contract_identity mapping where one exists,
  // otherwise generate a fresh uuid client-side rather than relying on the
  // column default, so every row in the batch has a real, uniform id.
  const rows = ngem.bids.map(fromNgem).map(r => ({
    ...r,
    id: identityMap[r.source_record_id] || crypto.randomUUID(),
  }));
  console.log('[sync-supabase-nv] ngem: ' + rows.length + ' bids mapped');

  // Never let a fresh discovery pass downgrade a package that real
  // acquisition work has already advanced past discovery -- see
  // fetchAdvancedPackageIds. A brand-new id (no prior identity) can't have
  // advanced status yet, so only pre-existing identity ids need checking.
  const advancedIds = await fetchAdvancedPackageIds(Object.values(identityMap));
  const freshRows = [];
  const advancedRows = [];
  for (const r of rows) {
    if (advancedIds.has(r.id)) {
      const { package_status, package_document_count, package_completed_at, ...rest } = r;
      advancedRows.push(rest);
    } else {
      freshRows.push(r);
    }
  }
  console.log('[sync-supabase-nv] ' + advancedRows.length + ' row(s) already package-advanced -- upserting without touching package_status.');

  const freshResult = await upsertBatch(freshRows);
  const advancedResult = await upsertBatch(advancedRows);
  const ok = freshResult.ok + advancedResult.ok;
  const failed = freshResult.failed + advancedResult.failed;
  console.log('[sync-supabase-nv] upserted ' + ok + ' row(s), ' + failed + ' failed, into ' + TABLE + '.');

  const closed = await closeExpired();
  console.log('[sync-supabase-nv] marked ' + closed + ' NV row(s) closed (response_deadline passed).');
}

main().catch(e => {
  console.error('[sync-supabase-nv] FAILED:', e.message);
  process.exit(0);
});
