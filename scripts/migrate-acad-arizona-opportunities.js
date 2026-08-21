'use strict';
/* One-off recovery migration, 2026-08-21: APROPOS-CONTRACT-ACQUISITION-
   DISCOVERY-CENTER ("ACAD") was a retired AZ contract-acquisition testing
   site (now repurposed as an opportunity-tracking monitor). Before its
   astb_opportunities/astb_documents tables get cleaned up, this recovers
   the real data into the main pipeline: 31 real opportunities across 4
   already-registered AZ publishers (Arizona DOT, University of Arizona,
   Northern Arizona University, Arizona Judicial Branch), with 142 real
   already-downloaded documents (579MB total) copied byte-for-byte from
   ACAD's own private storage into the main project's solicitation-
   packages bucket -- not re-scraped, the real bytes ACAD already
   acquired.

   Source project: AI4 Intelligent Contact Center (pwvstaigtdrccirdvqka)
   -- ACAD_SUPABASE_URL / ACAD_SUPABASE_SERVICE_ROLE_KEY
   Destination project: Procurement Site Development (judislfknmhofcgzyozc)
   -- SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (existing secrets)

   Real status is re-verified against current date at migration time, not
   blindly carried over: a closing_at in the past, or source status
   EVALUATION (bid already closed, now under evaluation -- no vendor can
   still respond), is migrated as 'closed'. Only genuinely still-open
   bids are migrated as 'open'. */

const crypto = require('crypto');

const SRC_URL = (process.env.ACAD_SUPABASE_URL || '').replace(/\/$/, '');
const SRC_KEY = process.env.ACAD_SUPABASE_SERVICE_ROLE_KEY;
const DST_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const DST_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'solicitation-packages';

// Fixed mapping -- these 4 publishers are already registered READY in the
// destination publisher_registry with existing publisher_assignments;
// confirmed live 2026-08-21, not guessed.
const PUBLISHER_MAP = {
  'Arizona Department of Transportation': {
    publisher_id: '3fe3d14c-9817-4730-9c89-952c9790aaec',
    assignment_id: '48f8891d-ca9d-454a-b227-ba02673cec16',
  },
  'University of Arizona': {
    publisher_id: '85c36c5d-3876-47fa-81e5-57e17cc61da5',
    assignment_id: '6a309d30-b6d1-47cd-97f4-4eb75fd2df50',
  },
  'Northern Arizona University': {
    publisher_id: '1e847cc5-9a23-42de-b534-85bc8b504a80',
    assignment_id: 'f97fec64-dc27-44da-9e43-96beb4e0f349',
  },
  'Arizona Judicial Branch': {
    publisher_id: '4badbcc2-edd3-4bab-a1b6-4259c3aa1dff',
    assignment_id: '1a2dd407-5a52-45b5-91bd-ddab64002202',
  },
};

function srcHeaders(extra) {
  return { apikey: SRC_KEY, Authorization: `Bearer ${SRC_KEY}`, ...(extra || {}) };
}
function dstHeaders(extra) {
  return { apikey: DST_KEY, Authorization: `Bearer ${DST_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) };
}
async function src(path, opts = {}) {
  const res = await fetch(`${SRC_URL}/rest/v1/${path}`, { ...opts, headers: { ...srcHeaders({ 'Content-Type': 'application/json' }), ...(opts.headers || {}) } });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ACAD source ${path} failed (${res.status}): ${raw.slice(0, 400)}`);
  return raw ? JSON.parse(raw) : null;
}
async function dst(path, opts = {}) {
  const res = await fetch(`${DST_URL}/rest/v1/${path}`, { ...opts, headers: { ...dstHeaders(opts.prefer ? { Prefer: opts.prefer } : {}), ...(opts.headers || {}) } });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Destination ${path} failed (${res.status}): ${raw.slice(0, 400)}`);
  return raw ? JSON.parse(raw) : null;
}
function cleanId(v) {
  return String(v ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'unknown';
}
function computeStatus(source_status, closing_at) {
  const now = Date.now();
  if (closing_at && new Date(closing_at).getTime() < now) return 'closed';
  if (String(source_status || '').toUpperCase() === 'OPEN') return 'open';
  return 'closed'; // EVALUATION and anything else: submission window has passed
}

async function transferDocument(doc, { publisherId, canonicalOpportunityId, sourceRecordId, rawRecordId }) {
  const getRes = await fetch(`${SRC_URL}/storage/v1/object/${doc.storage_bucket}/${doc.storage_path}`, { headers: srcHeaders() });
  if (!getRes.ok) throw new Error(`Source storage GET failed (${getRes.status}) for ${doc.storage_path}`);
  const buffer = Buffer.from(await getRes.arrayBuffer());
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const mime = doc.mime_type || getRes.headers.get('content-type') || 'application/pdf';
  const filename = cleanId(doc.document_name || doc.storage_path.split('/').pop());
  const storagePath = `${cleanId(publisherId)}/${cleanId(sourceRecordId)}/${digest.slice(0, 16)}/${filename}`;

  const uploadRes = await fetch(`${DST_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { apikey: DST_KEY, Authorization: `Bearer ${DST_KEY}`, 'Content-Type': mime, 'x-upsert': 'true' },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error(`Destination storage upload failed (${uploadRes.status}): ${(await uploadRes.text()).slice(0, 300)}`);

  await dst(`contract_package_documents?on_conflict=raw_record_id,source_url`, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({
      raw_record_id: rawRecordId,
      publisher_id: publisherId,
      canonical_opportunity_id: canonicalOpportunityId,
      source_record_id: sourceRecordId,
      source_url: doc.document_url,
      original_filename: doc.document_name,
      document_type: doc.document_type || 'OTHER',
      storage_bucket: BUCKET,
      storage_path: storagePath,
      mime_type: mime,
      byte_size: buffer.length,
      sha256: digest,
      retrieval_status: 'STORED',
      extraction_status: 'NOT_STARTED',
      metadata: { resolver: 'ACAD_RECOVERY_MIGRATION_2026_08_21', original_acad_storage_path: doc.storage_path },
      retrieved_at: new Date().toISOString(),
    }),
  });
  return { filename, bytes: buffer.length };
}

async function main() {
  if (!SRC_URL || !SRC_KEY) throw new Error('ACAD_SUPABASE_URL / ACAD_SUPABASE_SERVICE_ROLE_KEY not set.');
  if (!DST_URL || !DST_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');

  console.log('[migrate-acad] fetching astb_opportunities + astb_sources + astb_documents from ACAD...');
  const [opportunities, sources, documents] = await Promise.all([
    src('astb_opportunities?select=*'),
    src('astb_sources?select=id,publisher_name'),
    src('astb_documents?acquisition_status=eq.ACQUIRED&select=*'),
  ]);
  const sourceById = Object.fromEntries(sources.map((s) => [s.id, s.publisher_name]));
  const docsByOpportunity = {};
  for (const d of documents) (docsByOpportunity[d.opportunity_id] ||= []).push(d);

  console.log(`[migrate-acad] ${opportunities.length} opportunities, ${documents.length} acquired documents to migrate.`);

  // One command_run for the whole recovery, one acquisition_run per publisher.
  const commandRun = await dst('command_runs', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({
      idempotency_key: 'acad-arizona-recovery-2026-08-21',
      mission_name: 'ACAD Arizona Opportunity Recovery',
      mission_type_key: 'CONTRACT_PACKAGE_ACQUISITION',
      state_code: 'AZ',
      status: 'completed',
      aadp_state: 'COMPLETED',
      result_summary: 'One-off recovery of real AZ opportunities + already-acquired documents from the retired APROPOS-CONTRACT-ACQUISITION-DISCOVERY-CENTER (ACAD) testing site before its tables are cleaned up.',
    }),
  });
  const commandRunId = commandRun[0].id;

  const acquisitionRunByPublisher = {};
  for (const [name, { assignment_id }] of Object.entries(PUBLISHER_MAP)) {
    const run = await dst('acquisition_runs', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({ command_run_id: commandRunId, assignment_id, status: 'CREATED' }) });
    acquisitionRunByPublisher[name] = run[0].id;
  }

  const results = [];
  for (const opp of opportunities) {
    const publisherName = sourceById[opp.source_id];
    const mapping = PUBLISHER_MAP[publisherName];
    if (!mapping) { console.log('[migrate-acad] SKIP (no publisher mapping):', publisherName, opp.solicitation_number); continue; }

    const status = computeStatus(opp.status, opp.closing_at);
    const sourceRecordId = `acad_${cleanId(opp.solicitation_number)}`;
    const docs = docsByOpportunity[opp.id] || [];

    console.log(`[migrate-acad] === ${publisherName} / ${opp.solicitation_number} (${opp.status} -> ${status}) -- ${docs.length} doc(s) ===`);

    // Idempotent: reuse an existing raw record (and its already-registered
    // apie_contract_identity row) if this script already ran once for this
    // opportunity, instead of creating a duplicate.
    const existing = await dst(`acquisition_raw_records?source_record_id=eq.${encodeURIComponent(sourceRecordId)}&select=id,canonical_opportunity_id`);
    let rawRecordId, canonicalOpportunityId;
    if (existing.length) {
      rawRecordId = existing[0].id;
      canonicalOpportunityId = existing[0].canonical_opportunity_id;
      console.log('[migrate-acad]   reusing existing raw record', rawRecordId);
    } else {
      canonicalOpportunityId = crypto.randomUUID();
      // apie_contract_identity must exist before contract_package_documents
      // can reference this canonical_opportunity_id (FK constraint).
      await dst('apie_contract_identity', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({
          id: canonicalOpportunityId,
          pdas_record_id: `PDAS-${crypto.randomUUID().replace(/-/g, '')}`,
          source_platform: 'acad_arizona_recovery',
          source_record_id: sourceRecordId,
          current_location: 'PROCESSING',
        }),
      });
      const rawRecord = await dst('acquisition_raw_records', {
        method: 'POST', prefer: 'return=representation',
        body: JSON.stringify({
          acquisition_run_id: acquisitionRunByPublisher[publisherName],
          assignment_id: mapping.assignment_id,
          publisher_id: mapping.publisher_id,
          canonical_opportunity_id: canonicalOpportunityId,
          source_record_id: sourceRecordId,
          source_url: opp.official_record_url || opp.primary_document_url || 'https://cnsads.azdot.gov/current',
          raw_payload: {
            title: opp.title,
            solicitation_number: opp.solicitation_number,
            issuing_entity: opp.issuing_entity,
            status_at_recovery: status,
            original_source_status: opp.status,
            posted_date: opp.posted_date,
            closing_at: opp.closing_at,
            description: opp.raw_source_record?.description || null,
            documents: docs.map((d) => ({ name: d.document_name, type: d.document_type })),
            recovered_from: 'ACAD (APROPOS-CONTRACT-ACQUISITION-DISCOVERY-CENTER)',
            recovered_at: new Date().toISOString(),
          },
          package_status: docs.length ? 'PACKAGE_DISCOVERED' : 'PACKAGE_NOT_STARTED',
          package_document_count: docs.length,
          source_fingerprint: crypto.createHash('sha256').update(sourceRecordId + '|acad_arizona_recovery').digest('hex'),
          content_fingerprint: crypto.createHash('sha256').update(sourceRecordId + '|acad_arizona_recovery').digest('hex'),
        }),
      });
      rawRecordId = rawRecord[0].id;
    }

    let stored = 0;
    for (const doc of docs) {
      try {
        const result = await transferDocument(doc, { publisherId: mapping.publisher_id, canonicalOpportunityId, sourceRecordId, rawRecordId });
        stored += 1;
        console.log('[migrate-acad]   transferred:', result.filename, '(', result.bytes, 'bytes)');
      } catch (error) {
        console.log('[migrate-acad]   FAILED:', doc.document_name, '-', error.message);
      }
    }
    const packageStatus = docs.length && stored === docs.length ? 'PACKAGE_COMPLETE' : stored ? 'PACKAGE_PARTIAL' : docs.length ? 'PACKAGE_FAILED' : 'PACKAGE_NOT_STARTED';
    await dst(`acquisition_raw_records?id=eq.${rawRecordId}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ package_status: packageStatus, package_completed_at: packageStatus === 'PACKAGE_COMPLETE' ? new Date().toISOString() : null }),
    });
    results.push({ solicitation_number: opp.solicitation_number, publisher: publisherName, status, docsStored: stored, docsTotal: docs.length, packageStatus });
  }

  console.log('[migrate-acad] SUMMARY:', JSON.stringify(results, null, 2));
  console.log(`[migrate-acad] DONE -- migrated ${results.length} opportunities.`);
}

main().catch((e) => { console.error('[migrate-acad] FATAL:', e.message); process.exit(1); });
