'use strict';
/* CivicPlus/CivicEngage "Bids.aspx" connector, shared across multiple NV
   counties on the same underlying platform. Confirmed live 2026-08-21 via
   direct curl (no login, plain server-rendered HTML, no ViewState postback
   needed for the list view -- unlike Washoe's grid, which requires one):

     Lyon County       https://www.lyon-county.org/bids.aspx
     Churchill County  https://www.churchillcountynv.gov/bids.aspx
     White Pine County https://www.whitepinecounty.net/Bids.aspx
     Nye County        https://www.nyecountynv.gov/Bids.aspx
     Humboldt County   https://www.humboldtcountynv.gov/Bids.aspx
     Storey County     https://www.storeycounty.org/bids.aspx  (added 2026-08-21)

   (Nye County already had a publisher_registry row marked READY with
   connector_strategy=STATEFUL_SESSION_OR_HEADLESS_BROWSER / HIGH
   complexity -- that assessment was wrong, no connector was ever actually
   built, and live testing confirms plain GET is all that's needed. This
   script corrects that and adds the other four.)

   Each bid row on the list page carries a real title, description
   snippet, status (Open/Closed/Awarded), and closing date -- no detail
   fetch needed for that. For Open bids we do one extra GET of the detail
   page (bids.aspx?bidID=N) to pull real DocumentCenter attachment links,
   confirmed live to be plain public PDFs (no login/CSRF), so document_urls
   is populated directly, unlike Washoe/NGEM where package acquisition is a
   separate later step. */

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SITES = [
  { key: 'lyon', county: 'Lyon', jurisdiction_name: 'Lyon County', base: 'https://www.lyon-county.org/bids.aspx', city: 'Yerington' },
  { key: 'churchill', county: 'Churchill', jurisdiction_name: 'Churchill County', base: 'https://www.churchillcountynv.gov/bids.aspx', city: 'Fallon' },
  { key: 'white_pine', county: 'White Pine', jurisdiction_name: 'White Pine County', base: 'https://www.whitepinecounty.net/Bids.aspx', city: 'Ely' },
  { key: 'nye', county: 'Nye', jurisdiction_name: 'Nye County', base: 'https://www.nyecountynv.gov/Bids.aspx', city: 'Tonopah' },
  { key: 'humboldt', county: 'Humboldt', jurisdiction_name: 'Humboldt County', base: 'https://www.humboldtcountynv.gov/Bids.aspx', city: 'Winnemucca' },
  { key: 'storey', county: 'Storey', jurisdiction_name: 'Storey County', base: 'https://www.storeycounty.org/bids.aspx', city: 'Virginia City' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}
function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`);
  return res.text();
}

function parseListRows(html) {
  const rowRe = /<div class="listItemsRow bid">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(html))) {
    const block = m[0];
    const linkMatch = block.match(/href="(bids\.aspx\?bidID=\d+)"/i);
    const titleMatch = block.match(/<a href="bids\.aspx\?bidID=\d+">([^<]*)<\/a>/i);
    const bidIdMatch = linkMatch ? linkMatch[1].match(/bidID=(\d+)/i) : null;
    const descMatch = block.match(/<span>([^<]{40,2000})\s*\[<a/);
    const statusMatch = block.match(/<span>(Open|Closed|Awarded|Cancelled)<\/span>/i);
    const closesMatch = block.match(/<span>(Open|Closed|Awarded|Cancelled)<\/span><br>\s*<span>([^<]*)<\/span>/i);
    if (!bidIdMatch || !titleMatch) continue;
    rows.push({
      bid_id: bidIdMatch[1],
      title: decodeEntities(titleMatch[1]).trim(),
      description: descMatch ? decodeEntities(descMatch[1]).trim() : null,
      status: statusMatch ? statusMatch[1] : null,
      closes: closesMatch ? closesMatch[2].trim() : null,
    });
  }
  return rows;
}

async function fetchDocuments(base, bidId) {
  try {
    const url = `${base}?bidID=${bidId}`;
    const html = await fetchHtml(url);
    const origin = new URL(base).origin;
    const docs = [];
    // Real markup varies by county, confirmed live 2026-08-21: Churchill
    // uses a structured "relatedDocuments" attachment block; Lyon instead
    // pastes the document link directly into the free-text description.
    // Both forms live inside a <span class="BidDetail">...</span> field
    // block (used both for the description and for small field labels
    // like "Bid Number:") -- scanning every such span, rather than the
    // whole page, is what excludes the page's global site-tools nav,
    // which also links unrelated DocumentCenter items (e.g. a "County
    // Master Plan (PDF)") and would otherwise falsely attach to every bid.
    const spanRe = /<span class="BidDetail">([\s\S]*?)<\/span>/gi;
    const linkRe = /href=("?)((?:https?:\/\/[^\s">]*)?\/DocumentCenter\/View\/\d+[^\s">]*)\1/gi;
    let spanMatch;
    while ((spanMatch = spanRe.exec(html))) {
      let m;
      linkRe.lastIndex = 0;
      while ((m = linkRe.exec(spanMatch[1]))) {
        let url2 = decodeEntities(m[2]);
        if (url2.startsWith('/')) url2 = origin + url2;
        if (!docs.some((d) => d.url === url2)) docs.push({ url: url2 });
      }
    }
    return { docs, detailUrl: url };
  } catch (e) {
    console.log('[scrape-civicplus-nv-counties]   detail fetch failed for bidID', bidId, '-', e.message);
    return { docs: [], detailUrl: `${base}?bidID=${bidId}` };
  }
}

async function scrapeSite(site) {
  console.log('[scrape-civicplus-nv-counties] ===', site.jurisdiction_name, '===');
  const html = await fetchHtml(site.base);
  const rows = parseListRows(html);
  console.log('[scrape-civicplus-nv-counties]   list rows:', rows.length);

  const out = [];
  for (const row of rows) {
    let docs = [];
    let detailUrl = `${site.base}?bidID=${row.bid_id}`;
    if (String(row.status || '').toLowerCase() === 'open') {
      const result = await fetchDocuments(site.base, row.bid_id);
      docs = result.docs;
      detailUrl = result.detailUrl;
      console.log('[scrape-civicplus-nv-counties]  ', row.title, '- status:', row.status, '- docs:', docs.length);
      await sleep(500);
    } else {
      console.log('[scrape-civicplus-nv-counties]  ', row.title, '- status:', row.status, '(skipping doc fetch, not Open)');
    }
    out.push({ ...row, detail_url: detailUrl, documents: docs, county: site.county, jurisdiction_name: site.jurisdiction_name, city: site.city, source_base: site.base });
  }
  return out;
}

async function main() {
  const all = [];
  for (const site of SITES) {
    try {
      const rows = await scrapeSite(site);
      all.push(...rows);
    } catch (e) {
      console.log('[scrape-civicplus-nv-counties] FAILED site', site.jurisdiction_name, '-', e.message);
    }
    await sleep(800);
  }
  const out = { scraped_at: new Date().toISOString(), bids: all };
  fs.writeFileSync(path.join(__dirname, '..', 'civicplus-nv-counties.json'), JSON.stringify(out, null, 2));
  console.log('[scrape-civicplus-nv-counties] WROTE civicplus-nv-counties.json —', all.length, 'total bid rows across', SITES.length, 'counties.');
}

main().catch((e) => { console.error('[scrape-civicplus-nv-counties] FATAL:', e.message); process.exit(1); });
