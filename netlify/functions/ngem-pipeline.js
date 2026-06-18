'use strict';
// StateGen — NGEM (Nevada Government eMarketplace) ingest adapter.
// GET → returns open Nevada state/local solicitations in a normalized shape.
//
// LIVE: NGEM runs on Ionwave (nevada.ionwave.net). Its public "Current Bids" list
// (SourcingEvents.aspx?SourceType=1) is viewable without login — a single GET with a
// browser User-Agent returns the full Telerik grid. We scrape and normalize it.
// If the live read fails for any reason, we fall back to a sample set so the site stays up.

const LIST_URL   = 'https://nevada.ionwave.net/SourcingEvents.aspx?SourceType=1'; // public current bids
const DETAIL_URL = 'https://nevada.ionwave.net/PublicDetail.aspx';                // ?bidID=N&SourceType=1
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=300',
};

// Normalized opportunity shape (source-agnostic):
// { id, solicitation_no, title, bid_type, agency, issue_date, close_date, due_in_days, url, status }
const SAMPLE_BIDS = [
  { solicitation_no: 'NV-PUR-26-0204', title: 'Temporary Staffing — Administrative Support', bid_type: 'RFP', agency: 'State of Nevada — Purchasing Division', issue_date: '6/10/2026', close_date: '6/28/2026 02:00 PM (PT)', due_in_days: 11 },
  { solicitation_no: 'CC-IT-2026-044', title: 'Enterprise Network Infrastructure Upgrade', bid_type: 'BID', agency: 'Clark County, Nevada', issue_date: '6/8/2026', close_date: '7/1/2026 10:00 AM (PT)', due_in_days: 14 },
  { solicitation_no: 'COLV-PR-26-007', title: 'Citywide Park Landscape Maintenance', bid_type: 'BID', agency: 'City of Las Vegas, Nevada', issue_date: '6/12/2026', close_date: '6/26/2026 01:30 PM (PT)', due_in_days: 9 },
];

const cache = { at: 0, payload: null };
const TTL_MS = 5 * 60 * 1000;

function cleanCell(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

function dueInDays(closeStr) {
  const m = String(closeStr || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const due = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  return Math.ceil((due - new Date()) / 86400000);
}

function slug(s, i) {
  return String(s || ('row' + i)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || ('row' + i);
}

function parseBids(html) {
  // RadGrid ClientState maps each data-row index → BidID, e.g. "0":{"BidID":"20049"}.
  // That BidID drives the public Bid Opportunity Detail page.
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
    // columns: [select, Bid Number, Bid Title, Bid Type, Organization, Issue Date, Close Date/Time]
    if (cells.length < 7) continue;
    const solicitation_no = cells[1], title = cells[2];
    if (!title) continue;
    const close_date = cells[6].replace(/:00 ([AP]M)/, ' $1');
    const bidID = bidIdByRow[rowIdx];
    bids.push({
      id: bidID || slug(solicitation_no || title, rowIdx),
      bid_id: bidID || null,
      solicitation_no, title,
      bid_type: cells[3] || '—',
      agency: cells[4] || '—',
      issue_date: cells[5] || '',
      close_date,
      due_in_days: dueInDays(cells[6]),
      // Deep link straight to the public Bid Opportunity Detail page.
      url: bidID ? `${DETAIL_URL}?bidID=${bidID}&SourceType=1` : null,
    });
  }
  return bids;
}

async function fetchNgemBids() {
  const res = await fetch(LIST_URL, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error('NGEM HTTP ' + res.status);
  const html = await res.text();
  const bids = parseBids(html);
  if (!bids.length) throw new Error('NGEM parse returned 0 rows');
  return { mode: 'live', bids };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  if (cache.payload && (Date.now() - cache.at) < TTL_MS) {
    return { statusCode: 200, headers: CORS, body: cache.payload };
  }

  let mode, bids;
  try {
    ({ mode, bids } = await fetchNgemBids());
  } catch (e) {
    mode = 'sample';
    bids = SAMPLE_BIDS.slice();
  }

  const normalized = bids
    .map(b => ({
      ...b,
      status: 'Open',
      // No per-bid GET URL on Ionwave (row-click postback), so deep-link to the live
      // public current-bids list where the user can open this solicitation directly.
      url: b.url || LIST_URL,
    }))
    .filter(b => b.due_in_days === null || b.due_in_days >= 0) // drop already-closed
    .sort((a, b) => (a.due_in_days ?? 9999) - (b.due_in_days ?? 9999));

  const payload = JSON.stringify({
    source: 'ngem',
    state: 'NV',
    scanMode: mode,            // "live" when scraped, "sample" on fallback
    generatedAt: new Date().toISOString(),
    count: normalized.length,
    bids: normalized,
  });

  cache.at = Date.now();
  cache.payload = payload;
  return { statusCode: 200, headers: CORS, body: payload };
};
