'use strict';
/* Real NevadaePro (State of Nevada Purchasing Division) document
   acquisition connector. Verified live 2026-08-20: the whole site is
   public, no login anywhere -- not even for file downloads. A fresh GET
   of the bid detail page supplies a per-page CSRF token (`_csrf` hidden
   field); a plain POST of that token + the target `downloadFileNbr` +
   mode=download to the same page's own action URL returns the real file
   as an attachment (confirmed via curl: downloaded a genuine 29-page,
   13,132-word .doc with zero authentication).

   Writes real rows into contract_package_documents, keyed by the
   acquisition_raw_records seeded 2026-08-20 (see docs/pipeline-status-
   2026-08-20.json for the full provenance of that FK chain -- a manual
   backfill command_run/acquisition_run, reusing a publisher_assignment
   that already existed unused since 2026-08-02). No Playwright needed
   anywhere: plain fetch() + a lightweight cookie jar. */

const crypto = require('crypto');

const BASE = 'https://nevadaepro.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'solicitation-packages';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_RECORDS_PER_RUN = Number(process.env.MAX_RECORDS_PER_RUN || 8);
const PUBLISHER_ID = '2c3a9a0e-5299-44db-9ffa-6c5d7e3371ad';

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
  if (/addendum|addenda/.test(n)) return 'ADDENDUM';
  if (/amendment/.test(n)) return 'AMENDMENT';
  if (/scope of work|\bsow\b/.test(n)) return 'SCOPE_OF_WORK';
  if (/specification/.test(n)) return 'SPECIFICATIONS';
  if (/instruction/.test(n)) return 'INSTRUCTIONS';
  if (/questions? and answers?|q\s*&\s*a/.test(n)) return 'Q_AND_A';
  if (/price|pricing|cost schedule/.test(n)) return 'PRICING';
  if (/insurance|bond/.test(n)) return 'INSURANCE_BONDING';
  if (/certification|lobbying|reference.?questionnaire|vendor.?information/.test(n)) return 'FORMS';
  if (/terms.and.conditions|standard.form.contract/.test(n)) return 'CONTRACT_TERMS';
  return 'OTHER';
}

// Cookie jar: this connector needs no login, but the CSRF token is tied to
// the session cookie the detail-page GET sets, so the same cookie must be
// replayed on the download POST.
class Jar {
  constructor() { this.cookies = new Map(); }
  capture(res) {
    for (const [k, v] of res.headers.entries()) {
      if (k.toLowerCase() !== 'set-cookie') continue;
      const pair = v.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function fetchDetailAndCsrf(docId, jar) {
  const url = `${BASE}/bso/external/bidDetail.sda?docId=${encodeURIComponent(docId)}&external=true&parentUrl=close`;
  const res = await fetch(url, { headers: { 'user-agent': UA, cookie: jar.header() } });
  jar.capture(res);
  if (!res.ok) throw new Error(`Detail page fetch failed (${res.status})`);
  const html = await res.text();
  const csrfMatch = html.match(/name="_csrf" value="([^"]*)"/);
  if (!csrfMatch) throw new Error('CSRF token not found on detail page.');
  return csrfMatch[1];
}

async function downloadFile(docId, fileNbr, csrf, jar) {
  const body = new URLSearchParams({
    _csrf: csrf, mode: 'download', bidId: docId, docId, currentPage: '1',
    querySql: '', downloadFileNbr: fileNbr, itemNbr: '0', parentUrl: 'close',
    fromQuote: '', destination: '',
  });
  const res = await fetch(`${BASE}/bso/external/bidDetail.sda`, {
    method: 'POST',
    headers: { 'user-agent': UA, cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  jar.capture(res);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for file ${fileNbr}`);
  const contentType = res.headers.get('content-type') || '';
  if (/text\/html/i.test(contentType)) throw new Error('Download returned HTML instead of a file (stale CSRF or bad fileNbr).');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes.`);
  return { buffer, contentType };
}

async function storeDocument({ buffer, contentType, name, docId, fileNbr, rawRecordId, canonicalOpportunityId, sourceRecordId }) {
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = cleanId(name);
  const storagePath = `${cleanId(PUBLISHER_ID)}/${cleanId(sourceRecordId)}/${digest.slice(0, 16)}/${filename}`;
  const mime = contentType.split(';')[0].trim() || 'application/octet-stream';

  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': mime, 'x-upsert': 'true' },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error(`Storage upload failed (${uploadRes.status}): ${(await uploadRes.text()).slice(0, 300)}`);

  await sb('contract_package_documents?on_conflict=raw_record_id,source_url', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({
      raw_record_id: rawRecordId,
      publisher_id: PUBLISHER_ID,
      canonical_opportunity_id: canonicalOpportunityId,
      source_record_id: sourceRecordId,
      source_url: `${BASE}/bso/external/bidDetail.sda?docId=${docId}&downloadFileNbr=${fileNbr}`,
      original_filename: name,
      document_type: classifyDocument(name),
      storage_bucket: BUCKET,
      storage_path: storagePath,
      mime_type: mime,
      byte_size: buffer.length,
      sha256: digest,
      retrieval_status: 'STORED',
      extraction_status: 'NOT_STARTED',
      metadata: { file_nbr: fileNbr, resolver: 'NEVADAEPRO_DOWNLOAD_FORM' },
      retrieved_at: new Date().toISOString(),
    }),
  });
  return { filename: name, bytes: buffer.length };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');

  const eligible = await sb(
    `acquisition_raw_records?publisher_id=eq.${PUBLISHER_ID}&package_status=in.(PACKAGE_NOT_STARTED,PACKAGE_DISCOVERED,PACKAGE_PARTIAL,PACKAGE_FAILED)&select=id,source_record_id,canonical_opportunity_id,raw_payload`,
  );
  const batch = eligible.slice(0, MAX_RECORDS_PER_RUN);
  console.log('[acquire-nevadaepro-documents] eligible records:', eligible.length, '| processing this run (cap', MAX_RECORDS_PER_RUN, '):', batch.length);
  if (!batch.length) { console.log('[acquire-nevadaepro-documents] nothing to do.'); return; }

  const results = [];
  for (const raw of batch) {
    const docId = raw.source_record_id;
    const attachments = raw.raw_payload?.attachments || [];
    console.log('[acquire-nevadaepro-documents] ===', docId, '(' + attachments.length + ' attachments) ===');
    if (!attachments.length) {
      await sb(`acquisition_raw_records?id=eq.${raw.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ package_status: 'PACKAGE_PARTIAL', package_document_count: 0 }) });
      results.push({ id: docId, status: 'NO_ATTACHMENTS' });
      continue;
    }
    try {
      const jar = new Jar();
      const csrf = await fetchDetailAndCsrf(docId, jar);
      const stored = [];
      for (const att of attachments) {
        try {
          const { buffer, contentType } = await downloadFile(docId, att.file_nbr, csrf, jar);
          const result = await storeDocument({
            buffer, contentType, name: att.name, docId, fileNbr: att.file_nbr,
            rawRecordId: raw.id, canonicalOpportunityId: raw.canonical_opportunity_id, sourceRecordId: docId,
          });
          stored.push(result);
          console.log('[acquire-nevadaepro-documents]   stored:', result.filename, '(', result.bytes, 'bytes)');
        } catch (error) {
          console.log('[acquire-nevadaepro-documents]   FAILED:', att.name, '-', error.message);
        }
      }
      const packageStatus = stored.length === attachments.length ? 'PACKAGE_COMPLETE' : stored.length ? 'PACKAGE_PARTIAL' : 'PACKAGE_FAILED';
      await sb(`acquisition_raw_records?id=eq.${raw.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ package_status: packageStatus, package_document_count: attachments.length, package_completed_at: packageStatus === 'PACKAGE_COMPLETE' ? new Date().toISOString() : null }),
      });
      results.push({ id: docId, status: packageStatus, storedCount: stored.length, totalCount: attachments.length });
    } catch (error) {
      console.log('[acquire-nevadaepro-documents] FAILED record', docId, '-', error.message);
      await sb(`acquisition_raw_records?id=eq.${raw.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ package_status: 'PACKAGE_FAILED' }) }).catch(() => {});
      results.push({ id: docId, status: 'ERROR', error: error.message });
    }
  }
  console.log('[acquire-nevadaepro-documents] SUMMARY:', JSON.stringify(results, null, 2));
}

main().catch(e => { console.error('[acquire-nevadaepro-documents] FATAL:', e.message); process.exit(1); });
