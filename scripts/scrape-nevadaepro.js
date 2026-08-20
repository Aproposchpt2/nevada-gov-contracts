'use strict';
/* NevadaePro (State of Nevada Purchasing Division, Periscope Holdings S2G
   platform) discovery connector. Real, verified 2026-08-20: fully public,
   no login required anywhere -- search results, bid detail pages, and even
   file attachment downloads (a fresh page fetch supplies a CSRF token; a
   plain POST with that token + the target fileNbr returns the real file,
   confirmed by downloading a genuine 29-page .doc via curl with no
   authentication at all). Statewide coverage (every NV state agency/
   department), not just Clark County -- complements nevada-gov-contracts'
   existing NGEM (Clark County/local) connector rather than overlapping it.

   No Playwright needed anywhere in this connector: the whole site is
   server-rendered HTML (a PrimeFaces/JSF DataTable), unlike NGEM which
   needs a real browser for Cloudflare + JS-rendered listings. Plain
   fetch() + regex extraction only. */

const fs = require('fs');
const path = require('path');

const BASE = 'https://nevadaepro.com';
const LIST_URL = BASE + '/bso/view/search/external/advancedSearchBid.xhtml?openBids=true';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DETAIL_LIMIT = Number(process.env.DETAIL_LIMIT || 40);

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}
function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function fetchList() {
  const res = await fetch(LIST_URL, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error('List fetch failed: ' + res.status);
  return res.text();
}

function parseListRows(html) {
  const bodyMatch = html.match(/<tbody id="bidSearchResultsForm:bidResultId_data"[^>]*>([\s\S]*?)<\/tbody>/);
  if (!bodyMatch) return [];
  const rows = [];
  const rowRe = /<tr[^>]*data-ri="\d+"[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(bodyMatch[1]))) {
    const cellRe = /<td[^>]*role="gridcell"[^>]*>([\s\S]*?)<\/td>/g;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) cells.push(cellMatch[1]);
    if (cells.length < 11) continue;
    const docIdLinkMatch = cells[0].match(/docId=([^&"]+)/);
    const docId = docIdLinkMatch ? decodeEntities(docIdLinkMatch[1]) : stripTags(cells[0]);
    rows.push({
      doc_id: docId,
      organization: stripTags(cells[2]),
      buyer: stripTags(cells[5]),
      title: stripTags(cells[6]),
      bid_opening_date: stripTags(cells[7]),
      status: stripTags(cells[10]),
    });
  }
  return rows;
}

async function fetchDetail(docId) {
  const url = BASE + '/bso/external/bidDetail.sda?docId=' + encodeURIComponent(docId) + '&external=true&parentUrl=close';
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) return { detail_fetched: false, detail_error: 'HTTP ' + res.status };
  const html = await res.text();

  const csrfMatch = html.match(/name="_csrf" value="([^"]*)"/);

  const billToMatch = html.match(/Bill To:([\s\S]*?)<\/td>/);
  let contact_org = null, contact_email = null, contact_phone = null;
  if (billToMatch) {
    const lines = billToMatch[1].split(/<br\s*\/?>/i).map(stripTags).filter(Boolean);
    contact_org = lines[0] || null;
    const emailLine = lines.find(l => /^Email:/i.test(l));
    const phoneLine = lines.find(l => /^Phone:/i.test(l));
    contact_email = emailLine ? emailLine.replace(/^Email:\s*/i, '').trim() : null;
    contact_phone = phoneLine ? phoneLine.replace(/^Phone:\s*/i, '').trim() : null;
  }

  const descMatch = html.match(/Description:\s*<\/(?:td|b|strong)>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
    || html.match(/<b>Description:<\/b>\s*([\s\S]*?)<\/td>/i);
  const title = descMatch ? stripTags(descMatch[1]) : null;

  // First item's full scope-of-work text, inside the "inputs-01" cell right
  // after "Item Information" -- multi-item bids exist, but the first item's
  // text alone is real, substantive scope text (easily passes the >=20 char
  // admission gate) and is enough for a v1 connector.
  let scope = null;
  const itemBlockMatch = html.match(/Item Information[\s\S]*?class="inputs-01">([\s\S]*?)<\/td>/);
  if (itemBlockMatch) scope = stripTags(itemBlockMatch[1]);

  const attachments = [];
  const attachRe = /downloadFile\('(\d+)'\);"\s*\n?\s*class="link-01">([^<]+)<\/a>/g;
  let attachMatch;
  while ((attachMatch = attachRe.exec(html))) {
    attachments.push({ file_nbr: attachMatch[1], name: decodeEntities(attachMatch[2]).trim() });
  }

  return {
    detail_fetched: true,
    csrf_token: csrfMatch ? csrfMatch[1] : null,
    title: title || null,
    scope: scope || null,
    contact_org, contact_email, contact_phone,
    attachments,
    detail_url: url,
  };
}

function readJson(file) {
  const p = path.join(__dirname, '..', file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function main() {
  console.log('[scrape-nevadaepro] loading NevadaePro open bids list...');
  const listHtml = await fetchList();
  const rows = parseListRows(listHtml);
  console.log('[scrape-nevadaepro] list loaded:', rows.length, 'rows');

  const existing = readJson('nevadaepro.json');
  const existingById = new Map((existing && Array.isArray(existing.bids) ? existing.bids : []).map(b => [b.doc_id, b]));

  let detailFetches = 0;
  for (const row of rows) {
    const prior = existingById.get(row.doc_id);
    if (prior && prior.detail_fetched) { Object.assign(row, prior, row); continue; } // keep prior detail, refresh list fields
    if (detailFetches >= DETAIL_LIMIT) continue;
    detailFetches++;
    try {
      console.log('[scrape-nevadaepro] detail', detailFetches + '/' + DETAIL_LIMIT, '(' + row.doc_id + ')...');
      const detail = await fetchDetail(row.doc_id);
      Object.assign(row, detail);
    } catch (e) {
      console.log('[scrape-nevadaepro] detail fetch failed for', row.doc_id, '-', e.message);
      row.detail_fetched = false;
      row.detail_error = e.message;
    }
  }

  const out = { scraped_at: new Date().toISOString(), bids: rows };
  fs.writeFileSync(path.join(__dirname, '..', 'nevadaepro.json'), JSON.stringify(out, null, 2));
  console.log('[scrape-nevadaepro] WROTE nevadaepro.json —', rows.length, 'open bids,', rows.filter(r => r.detail_fetched).length, 'with full detail.');
}

main().catch(e => { console.error('[scrape-nevadaepro] FATAL:', e.message); process.exit(1); });
