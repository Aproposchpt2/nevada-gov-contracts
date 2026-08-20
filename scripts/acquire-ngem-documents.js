// Real NGEM document acquisition connector, using the authenticated vendor
// portal (supplier.ionwave.net) discovered 2026-08-17 -- NOT Bonfire, which
// was verified (via a real logged-in cross-check) to be an unrelated Clark
// County procurement channel with zero overlap with these bids.
//
// Path: Login.aspx -> Bid Events list -> match by solicitation_number ->
// bid detail (VResponseEvent.aspx) -> "Response Attachments" link ->
// VResponseBidAttachments.aspx (a Telerik RadGrid, same row-ID convention
// already used in scrape-ngem.js's parseAttachments) -> real Extract.aspx?e=
// download links, authenticated via the same Playwright session cookies.
//
// For each acquisition_raw_records row still needing its package (queried
// live from Supabase, not hardcoded): download every real attachment,
// upload to Supabase Storage (solicitation-packages bucket, same bucket
// APIE's own contract-package-engine.js uses), and write real rows into
// contract_package_documents -- reusing the shared schema so NAT-CORP's
// existing document viewer picks these up with no code changes on its side.
'use strict';
const { chromium } = require('playwright');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const USERNAME = process.env.NGEM_LOGIN_USERNAME;
const PASSWORD = process.env.NGEM_LOGIN_PASSWORD;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'solicitation-packages';
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Rate/visibility discipline: cap how many bids get pulled in a single run,
// and (on scheduled runs only, not manual workflow_dispatch testing) add a
// random startup delay so the request pattern doesn't land at the exact
// same minute every Mon/Wed/Fri. Cron alone can't randomize its own fire
// time, so the jitter lives here instead.
const MAX_RECORDS_PER_RUN = Number(process.env.MAX_RECORDS_PER_RUN || 5);
const JITTER_MAX_MINUTES = Number(process.env.JITTER_MAX_MINUTES || 180);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

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

async function waitOutCloudflare(page, maxAttempts = 6) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const t = await page.title();
    if (!/just a moment/i.test(t)) return;
    await page.waitForTimeout(5000);
  }
}

function cleanId(v) {
  return String(v ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'unknown';
}

function classifyDocument(name) {
  const n = String(name || '').toLowerCase();
  if (/addendum|addenda/.test(n)) return 'ADDENDUM';
  if (/amendment/.test(n)) return 'AMENDMENT';
  if (/scope of work|statement of work|\bsow\b/.test(n)) return 'SCOPE_OF_WORK';
  if (/specification/.test(n)) return 'SPECIFICATIONS';
  if (/instruction/.test(n)) return 'INSTRUCTIONS';
  if (/price|pricing|bid schedule/.test(n)) return 'PRICING';
  if (/insurance|bond/.test(n)) return 'INSURANCE_BONDING';
  if (/form|certification/.test(n)) return 'FORMS';
  if (/drawing|plan/.test(n)) return 'DRAWINGS';
  return 'OTHER';
}

async function login(page) {
  await page.goto('https://nevada.ionwave.net/Login.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitOutCloudflare(page);
  await page.fill('#txtUserName', USERNAME);
  await page.fill('#txtPassword', PASSWORD);
  const agreeBox = await page.$('#chkAgree');
  if (agreeBox) await agreeBox.click().catch(() => {});
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {}),
    page.click('#btnLogin'),
  ]);
  await page.waitForTimeout(3000);
  if (/login\.aspx/i.test(page.url())) throw new Error('NGEM login did not succeed.');
  console.log('[acquire-ngem-documents] logged in:', page.url());
}

async function findBidEventsMap(page) {
  const navLinks = await page.$$eval('a', els => els.map(el => ({ text: (el.textContent || '').trim(), href: el.href })));
  const bidEventsLink = navLinks.find(l => /bid\s*events/i.test(l.text));
  if (!bidEventsLink) throw new Error('Bid Events nav link not found.');
  await page.goto(bidEventsLink.href, { waitUntil: 'networkidle', timeout: 25000 });
  await waitOutCloudflare(page);

  // Map solicitation number (column index 2, 0-based) -> detail link, for
  // every visible row.
  const rows = await page.$$eval('table tbody tr', trs => trs.map(tr => {
    const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
    const link = tr.querySelector('a');
    return { cells, href: link ? link.href : null };
  }));
  const map = new Map();
  for (const row of rows) {
    const solicitation = row.cells[2];
    if (solicitation && row.href) map.set(solicitation.trim().toLowerCase(), row.href);
  }
  console.log('[acquire-ngem-documents] Bid Events rows mapped:', map.size);
  return map;
}

async function extractAttachments(page, detailHref) {
  await page.goto(detailHref, { waitUntil: 'networkidle', timeout: 25000 });
  await waitOutCloudflare(page);
  const attachmentsLink = await page.$('a:has-text("Response Attachments"), a:has-text("Attachments")');
  if (!attachmentsLink) return [];
  const attachHref = await attachmentsLink.getAttribute('href');
  await page.goto(attachHref, { waitUntil: 'networkidle', timeout: 25000 });
  await waitOutCloudflare(page);

  const rows = await page.$$eval('table tbody tr', trs => trs.map(tr => {
    const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
    const downloadLink = tr.querySelector('a[id*=lnkDownload]');
    return { cells, downloadHref: downloadLink ? downloadLink.href : null };
  }));
  return rows
    .filter(r => r.downloadHref && /Extract\.aspx/i.test(r.downloadHref))
    .map(r => ({ label: r.cells[0] || null, description: r.cells[1] || null, declaredSize: r.cells[2] || null, downloadUrl: r.downloadHref }));
}

async function downloadAndStore({ page, attachment, publisherId, canonicalOpportunityId, sourceRecordId, rawRecordId }) {
  const response = await page.request.get(attachment.downloadUrl, { timeout: 60000 });
  if (!response.ok()) throw new Error(`Download failed (${response.status()}) for ${attachment.label}`);
  const buffer = await response.body();
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`Attachment exceeds ${MAX_FILE_BYTES} bytes.`);
  const mime = (response.headers()['content-type'] || 'application/octet-stream').split(';')[0].trim();
  if (/text\/html/i.test(mime)) throw new Error('Attachment download returned HTML instead of a file (likely a stale/expired link).');

  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = cleanId(attachment.label || 'attachment');
  const storagePath = `${cleanId(publisherId)}/${cleanId(sourceRecordId)}/${digest.slice(0, 16)}/${filename}`;

  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': mime, 'x-upsert': 'true' },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error(`Storage upload failed (${uploadRes.status}): ${(await uploadRes.text()).slice(0, 300)}`);

  const documentType = classifyDocument(attachment.label);
  await sb(`contract_package_documents?on_conflict=raw_record_id,source_url`, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({
      raw_record_id: rawRecordId,
      publisher_id: publisherId,
      canonical_opportunity_id: canonicalOpportunityId,
      source_record_id: sourceRecordId,
      source_url: attachment.downloadUrl,
      original_filename: attachment.label,
      document_type: documentType,
      storage_bucket: BUCKET,
      storage_path: storagePath,
      mime_type: mime,
      byte_size: buffer.length,
      sha256: digest,
      retrieval_status: 'STORED',
      extraction_status: 'NOT_STARTED',
      metadata: { description: attachment.description || null, declared_size: attachment.declaredSize || null, resolver: 'NGEM_AUTHENTICATED_VENDOR_PORTAL' },
      retrieved_at: new Date().toISOString(),
    }),
  });
  return { filename: attachment.label, bytes: buffer.length, sha256: digest };
}

async function main() {
  if (!USERNAME || !PASSWORD) throw new Error('NGEM_LOGIN_USERNAME / NGEM_LOGIN_PASSWORD not set.');
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');

  // On a real scheduled run (not a manual workflow_dispatch test), wait a
  // random amount before doing anything -- keeps the actual request time
  // from landing at the same minute every Mon/Wed/Fri.
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && JITTER_MAX_MINUTES > 0) {
    const delayMinutes = Math.random() * JITTER_MAX_MINUTES;
    console.log(`[acquire-ngem-documents] scheduled run -- waiting ${delayMinutes.toFixed(1)} min before starting.`);
    await sleep(delayMinutes * 60 * 1000);
  }

  // Pull the real raw records still needing their package -- never hardcode
  // the bid list, always reflect current DB state. Cap and randomly select
  // which ones get pulled this run so volume/order stays modest and varied
  // rather than always hitting the same records first. Records that have
  // already failed 3+ times (almost always NOT_FOUND_IN_PORTAL -- genuinely
  // expired/removed from the authenticated Bid Events list) are excluded:
  // confirmed live 2026-08-20 that without this, the random draw kept
  // re-picking known-dead records every run, wasting a chunk of each run's
  // MAX_RECORDS_PER_RUN slots on repeats that were never going to succeed.
  const MAX_ATTEMPTS = 3;
  const eligibleRecords = await sb(
    `acquisition_raw_records?package_status=in.(PACKAGE_NOT_STARTED,PACKAGE_DISCOVERED,PACKAGE_PARTIAL,PACKAGE_FAILED)&publisher_id=eq.15314e83-769c-4943-8b29-7312a8cd51d4&processing_attempt_count=lt.${MAX_ATTEMPTS}&select=id,source_record_id,canonical_opportunity_id,publisher_id,raw_payload,processing_attempt_count`,
  );
  const rawRecords = shuffle(eligibleRecords).slice(0, MAX_RECORDS_PER_RUN);
  console.log('[acquire-ngem-documents] eligible records:', eligibleRecords.length, '| processing this run (cap', MAX_RECORDS_PER_RUN, '):', rawRecords.length);
  if (!rawRecords.length) { console.log('[acquire-ngem-documents] nothing to do.'); return; }

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 950 }, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const page = await ctx.newPage();

    await login(page);
    const bidEventsMap = await findBidEventsMap(page);

    const results = [];
    for (const raw of rawRecords) {
      const solicitation = String(raw.raw_payload?.solicitation_number || '').trim().toLowerCase();
      const title = raw.raw_payload?.title || raw.source_record_id;
      const detailHref = solicitation ? bidEventsMap.get(solicitation) : null;
      if (!detailHref) {
        console.log('[acquire-ngem-documents] NOT FOUND in Bid Events:', raw.source_record_id, title, '(solicitation:', solicitation, ')');
        await sb(`acquisition_raw_records?id=eq.${raw.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ package_status: 'PACKAGE_PARTIAL', detail_retrieval_error: 'Not found in authenticated Bid Events list (commodity-code mismatch or not yet posted).', processing_attempt_count: (raw.processing_attempt_count || 0) + 1 }) });
        results.push({ id: raw.source_record_id, title, status: 'NOT_FOUND_IN_PORTAL' });
        continue;
      }

      console.log('[acquire-ngem-documents] ===', raw.source_record_id, title, '===');
      try {
        const attachments = await extractAttachments(page, detailHref);
        console.log('[acquire-ngem-documents] attachments found:', attachments.length);
        if (!attachments.length) {
          await sb(`acquisition_raw_records?id=eq.${raw.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ package_status: 'PACKAGE_PARTIAL', package_document_count: 0 }) });
          results.push({ id: raw.source_record_id, title, status: 'NO_ATTACHMENTS' });
          continue;
        }

        const stored = [];
        for (const attachment of attachments.slice(0, 30)) {
          try {
            const result = await downloadAndStore({ page, attachment, publisherId: raw.publisher_id, canonicalOpportunityId: raw.canonical_opportunity_id, sourceRecordId: raw.source_record_id, rawRecordId: raw.id });
            stored.push(result);
            console.log('[acquire-ngem-documents]   stored:', result.filename, '(', result.bytes, 'bytes)');
          } catch (error) {
            console.log('[acquire-ngem-documents]   FAILED:', attachment.label, '-', error.message);
          }
        }

        const packageStatus = stored.length === attachments.length ? 'PACKAGE_COMPLETE' : stored.length ? 'PACKAGE_PARTIAL' : 'PACKAGE_FAILED';
        await sb(`acquisition_raw_records?id=eq.${raw.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ package_status: packageStatus, package_document_count: attachments.length, package_completed_at: packageStatus === 'PACKAGE_COMPLETE' ? new Date().toISOString() : null }),
        });
        results.push({ id: raw.source_record_id, title, status: packageStatus, storedCount: stored.length, totalCount: attachments.length });
      } catch (error) {
        console.log('[acquire-ngem-documents] FAILED bid', raw.source_record_id, '-', error.message);
        await sb(`acquisition_raw_records?id=eq.${raw.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ package_status: 'PACKAGE_FAILED', detail_retrieval_error: error.message.slice(0, 500), processing_attempt_count: (raw.processing_attempt_count || 0) + 1 }) }).catch(() => {});
        results.push({ id: raw.source_record_id, title, status: 'ERROR', error: error.message });
      }
    }

    console.log('[acquire-ngem-documents] SUMMARY:', JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[acquire-ngem-documents] FATAL:', e.message); process.exit(1); });
