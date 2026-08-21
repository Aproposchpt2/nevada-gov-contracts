// Document acquisition for the CivicPlus NV county connector (Lyon,
// Churchill, White Pine, Nye, Humboldt). Simplest of the four NV document
// connectors built this session: real DocumentCenter PDFs are genuinely
// public (confirmed live 2026-08-21 via plain curl), so this is a plain
// GET + Storage upload + contract_package_documents write, no CSRF/cookie
// jar (NevadaePro) or authenticated login/ViewState (NGEM/Washoe) needed.
'use strict';
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'solicitation-packages';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const PLATFORM = 'civicplus_nv_county';

function sbHeaders(prefer) {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  if (prefer) h.Prefer = prefer;
  return h;
}
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...sbHeaders(opts.prefer), ...(opts.headers || {}) } });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Supabase ${path} failed (${res.status}): ${raw.slice(0, 500)}`);
  return raw ? JSON.parse(raw) : null;
}
function cleanId(v) {
  return String(v ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'unknown';
}
function classifyDocument(name) {
  const n = String(name || '').toLowerCase();
  if (/addend/.test(n)) return 'ADDENDUM';
  if (/amend/.test(n)) return 'AMENDMENT';
  if (/scope of work|statement of work|\bsow\b/.test(n)) return 'SCOPE_OF_WORK';
  if (/spec/.test(n)) return 'SPECIFICATIONS';
  if (/instruct/.test(n)) return 'INSTRUCTIONS';
  if (/price|pricing|bid schedule/.test(n)) return 'PRICING';
  if (/insurance|bond/.test(n)) return 'INSURANCE_BONDING';
  if (/form|certif/.test(n)) return 'FORMS';
  if (/drawing|plan/.test(n)) return 'DRAWINGS';
  if (/rfq|qualification/.test(n)) return 'SCOPE_OF_WORK';
  return 'OTHER';
}

async function downloadAndStore({ url, publisherId, canonicalOpportunityId, sourceRecordId, rawRecordId }) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`Attachment exceeds ${MAX_FILE_BYTES} bytes.`);
  const mime = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  if (/text\/html/i.test(mime)) throw new Error('Download returned HTML instead of a file.');

  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = cleanId(decodeURIComponent(url.split('/').pop() || 'document'));
  const storagePath = `${cleanId(publisherId)}/${cleanId(sourceRecordId)}/${digest.slice(0, 16)}/${filename}`;

  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': mime, 'x-upsert': 'true' },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error(`Storage upload failed (${uploadRes.status}): ${(await uploadRes.text()).slice(0, 300)}`);

  await sb(`contract_package_documents?on_conflict=raw_record_id,source_url`, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({
      raw_record_id: rawRecordId,
      publisher_id: publisherId,
      canonical_opportunity_id: canonicalOpportunityId,
      source_record_id: sourceRecordId,
      source_url: url,
      original_filename: filename,
      document_type: classifyDocument(filename),
      storage_bucket: BUCKET,
      storage_path: storagePath,
      mime_type: mime,
      byte_size: buffer.length,
      sha256: digest,
      retrieval_status: 'STORED',
      extraction_status: 'NOT_STARTED',
      metadata: { resolver: 'CIVICPLUS_PUBLIC_DOCUMENTCENTER' },
      retrieved_at: new Date().toISOString(),
    }),
  });
  return { filename, bytes: buffer.length, sha256: digest };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');

  const eligible = await sb(`acquisition_raw_records?package_status=in.(PACKAGE_DISCOVERED,PACKAGE_PARTIAL)&publisher_id=in.(${
    // All 5 CivicPlus NV county publisher_ids, corrected/added 2026-08-21.
    ['d0ebc396-2933-49d1-88ad-d27e627af1f1', 'eb199ef5-8eb2-4f68-901e-6d191e11c66a', '9ae7c13b-2220-4a68-a7bd-080966062c29', '624e151a-06db-4d60-9a85-33f783d711ba', 'c28ec03b-13ea-46dc-9219-c97148e51bfd'].join(',')
  })&select=id,source_record_id,canonical_opportunity_id,publisher_id,raw_payload`);
  console.log('[acquire-civicplus-nv-documents] eligible records:', eligible.length);
  if (!eligible.length) { console.log('[acquire-civicplus-nv-documents] nothing to do.'); return; }

  const results = [];
  for (const raw of eligible) {
    const docUrls = raw.raw_payload?.document_urls || [];
    console.log('[acquire-civicplus-nv-documents] ===', raw.source_record_id, '-', docUrls.length, 'document(s) ===');
    if (!docUrls.length) {
      await sb(`acquisition_raw_records?id=eq.${raw.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ package_status: 'PACKAGE_FAILED', detail_retrieval_error: 'No document URLs found at scrape time.' }) });
      results.push({ id: raw.source_record_id, status: 'NO_DOCUMENTS' });
      continue;
    }
    const stored = [];
    for (const url of docUrls) {
      try {
        const result = await downloadAndStore({ url, publisherId: raw.publisher_id, canonicalOpportunityId: raw.canonical_opportunity_id, sourceRecordId: raw.source_record_id, rawRecordId: raw.id });
        stored.push(result);
        console.log('[acquire-civicplus-nv-documents]   stored:', result.filename, '(', result.bytes, 'bytes)');
      } catch (error) {
        console.log('[acquire-civicplus-nv-documents]   FAILED:', url, '-', error.message);
      }
    }
    const packageStatus = stored.length === docUrls.length ? 'PACKAGE_COMPLETE' : stored.length ? 'PACKAGE_PARTIAL' : 'PACKAGE_FAILED';
    await sb(`acquisition_raw_records?id=eq.${raw.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ package_status: packageStatus, package_document_count: docUrls.length, package_completed_at: packageStatus === 'PACKAGE_COMPLETE' ? new Date().toISOString() : null }),
    });
    results.push({ id: raw.source_record_id, status: packageStatus, storedCount: stored.length, totalCount: docUrls.length });
  }
  console.log('[acquire-civicplus-nv-documents] SUMMARY:', JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error('[acquire-civicplus-nv-documents] FATAL:', e.message); process.exit(1); });
