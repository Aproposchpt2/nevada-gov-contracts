'use strict';
/* StateGen (NV) — NGEM (Nevada Government eMarketplace / Ionwave) scheduled ingest.
   NV previously had zero scheduled ingestion — netlify/functions/ngem-pipeline.js and
   ngem-detail.js only live-fetch per request (5-min in-memory cache, no persistence).
   This script is the first persistent NV ingestor: same public, no-login Ionwave
   endpoints, run on a schedule and written to ngem.json — same shape/convention as
   CA's scripts/scrape-caleprocure.js (list pass + capped detail pass with caching).

   Plain fetch only, no headless browser: confirmed live in ngem-pipeline.js that a
   single GET with a browser User-Agent returns the full rendered Telerik grid HTML,
   same for PublicDetail.aspx (ngem-detail.js). No JS rendering gate like PlanetBids/
   Cal eProcure, so no Playwright dependency needed here. */

const fs = require('fs');
const path = require('path');

const LIST_URL = 'https://nevada.ionwave.net/SourcingEvents.aspx?SourceType=1';
const DETAIL_URL = 'https://nevada.ionwave.net/PublicDetail.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const OUT_FILE = path.join(__dirname, '..', 'ngem.json');
const DETAIL_DELAY_MS = 1500;

function argInt(name, dflt) {
  const m = process.argv.find(a => a.indexOf('--' + name + '=') === 0);
  return m ? parseInt(m.split('=')[1], 10) : dflt;
}
const DETAIL_LIMIT = argInt('detail-limit', 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanCell(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

// "6/28/2026 02:00 PM (PT)" -> { close_date: ISO string, due_in_days }
function parseNgemDate(s) {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return { close_date: null, due_in_days: null };
  const hour = parseInt(m[4], 10) % 12 + (/pm/i.test(m[6]) ? 12 : 0);
  const iso = m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':' + m[5] + ':00-07:00';
  const t = Date.parse(iso);
  return { close_date: Number.isNaN(t) ? null : new Date(t).toISOString(), due_in_days: Number.isNaN(t) ? null : Math.ceil((t - Date.now()) / 86400000) };
}

function parseBids(html) {
  const bidIdByRow = {};
  for (const k of html.matchAll(/"(\d+)":\{"BidID":"(\d+)"\}/g)) bidIdByRow[k[1]] = k[2];

  const gi = html.indexOf('rgBidList_ctl00"');
  const seg = gi > 0 ? html.slice(gi) : html;
  const rowRe = /id="ctl00_mainContent_rgBidList_ctl00__(\d+)"([\s\S]*?)(?=id="ctl00_mainContent_rgBidList_ctl00__\d+"|<\/table)/g;
  const bids = [];
  let m;
  while ((m = rowRe.exec(seg)) !== null) {
    const rowIdx = m[1];
    const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => cleanCell(c[1]));
    if (cells.length < 7) continue;
    const solicitation_no = cells[1], title = cells[2];
    if (!title) continue;
    const closeRaw = cells[6].replace(/:00 ([AP]M)/, ' $1');
    const bidID = bidIdByRow[rowIdx];
    const parsed = parseNgemDate(closeRaw);
    bids.push({
      id: bidID || (solicitation_no || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48),
      bid_id: bidID || null,
      solicitation_no, title,
      bid_type: cells[3] || '—',
      agency: cells[4] || '—',
      issue_date: cells[5] || '',
      close_date_raw: closeRaw,
      close_date: parsed.close_date,
      due_in_days: parsed.due_in_days,
      url: bidID ? `${DETAIL_URL}?bidID=${bidID}&SourceType=1` : LIST_URL,
    });
  }
  return bids;
}

function clean(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ').trim();
}
function extract(html, patterns) {
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m && m[1] && clean(m[1]).length > 5) return clean(m[1]);
  }
  return null;
}
function parseDetail(html) {
  const description = extract(html, [
    /id="[^"]*lblDescription[^"]*"[^>]*>([\s\S]{10,3000}?)<\/span>/i,
    /id="[^"]*lblNotes[^"]*"[^>]*>([\s\S]{10,3000}?)<\/span>/i,
    /id="[^"]*lblComments[^"]*"[^>]*>([\s\S]{10,3000}?)<\/span>/i,
    /id="[^"]*lblScopeOfWork[^"]*"[^>]*>([\s\S]{10,3000}?)<\/span>/i,
  ]);
  const contactName = extract(html, [/id="[^"]*lblContactName[^"]*"[^>]*>([^<]{5,100})</i]);
  const contactEmail = extract(html, [/id="[^"]*lnkEmail[^"]*"[^>]*href="mailto:([^"?]+)/i, /mailto:([^"?@\s]{1,80}@[^"?\s]{1,80})"/i]);
  const contactPhone = extract(html, [/id="[^"]*lblPhoneNumber[^"]*"[^>]*>([^<]{7,30})</i]);
  const docMatches = [...html.matchAll(/href="[^"]*(?:Download|Document|Attachment)[^"]*"[^>]*>([^<]{3,100})</gi)];
  const documents = [...new Set(docMatches.map(m => clean(m[1])).filter(d => d.length > 3))];
  return { description, contactName, contactEmail, contactPhone, documents };
}

async function fetchDetail(bidID) {
  const url = `${DETAIL_URL}?bidID=${bidID}&SourceType=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    return parseDetail(html);
  } catch (e) {
    console.log('[scrape-ngem] detail fetch failed for', bidID, ':', e.message);
    return null;
  }
}

async function main() {
  let existing = { bids: [] };
  if (fs.existsSync(OUT_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (e) {}
  }
  const existingById = {};
  (existing.bids || []).forEach(b => { existingById[b.id] = b; });

  console.log('[scrape-ngem] loading NGEM current bids list...');
  const res = await fetch(LIST_URL, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!res.ok) throw new Error('NGEM list HTTP ' + res.status);
  const html = await res.text();
  let bids = parseBids(html);
  console.log('[scrape-ngem] list loaded: ' + bids.length + ' rows');

  bids = bids.filter(b => b.due_in_days === null || b.due_in_days >= 0);

  const needDetail = bids.filter(b => b.bid_id && !(existingById[b.id] && existingById[b.id].detail_fetched)).map(b => b.bid_id);
  const toFetch = needDetail.slice(0, DETAIL_LIMIT);
  console.log('[scrape-ngem] ' + needDetail.length + ' bid(s) need detail; fetching ' + toFetch.length + ' this run (--detail-limit=' + DETAIL_LIMIT + ').');

  const detailById = {};
  for (let i = 0; i < toFetch.length; i++) {
    const id = toFetch[i];
    process.stdout.write('[scrape-ngem] detail ' + (i + 1) + '/' + toFetch.length + ' (' + id + ')... ');
    const d = await fetchDetail(id);
    console.log(d ? 'ok' : 'FAILED');
    if (d) detailById[id] = d;
    await sleep(DETAIL_DELAY_MS);
  }

  const merged = bids.map(b => {
    const prior = existingById[b.id] || {};
    const detail = b.bid_id ? detailById[b.bid_id] : null;
    return {
      ...b,
      status: 'Open',
      description: (detail && detail.description) || prior.description || null,
      contact_name: (detail && detail.contactName) || prior.contact_name || null,
      contact_email: (detail && detail.contactEmail) || prior.contact_email || null,
      contact_phone: (detail && detail.contactPhone) || prior.contact_phone || null,
      documents: (detail && detail.documents) || prior.documents || [],
      detail_fetched: !!((detail && detail.description) || prior.detail_fetched),
    };
  }).sort((a, b) => (a.due_in_days ?? 9999) - (b.due_in_days ?? 9999));

  const payload = {
    source: 'ngem', state: 'NV',
    generatedAt: new Date().toISOString(),
    count: merged.length,
    detail_fetched_count: merged.filter(b => b.detail_fetched).length,
    bids: merged,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log('[scrape-ngem] WROTE ngem.json — ' + merged.length + ' open bids, ' + payload.detail_fetched_count + ' with full detail.');
}

main().catch(e => { console.error('[scrape-ngem] FAILED:', e.message); process.exit(1); });
