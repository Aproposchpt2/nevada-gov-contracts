'use strict';
// NGCC — Ionwave bid detail scraper.
// GET ?bidID=XXXXX → returns description, scope, documents, contact for a single bid.
// PublicDetail.aspx is fully public — no login required.

const DETAIL_BASE = 'https://nevada.ionwave.net/PublicDetail.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function clean(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
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
  // ── Description / Scope ─────────────────────────────────────────────────
  // Ionwave uses lblDescription and lblNotes span IDs on both public and supplier portals
  const description = extract(html, [
    /id="[^"]*lblDescription[^"]*"[^>]*>([\s\S]{10,3000}?)<\/span>/i,
    /id="[^"]*lblNotes[^"]*"[^>]*>([\s\S]{10,3000}?)<\/span>/i,
    /id="[^"]*lblComments[^"]*"[^>]*>([\s\S]{10,3000}?)<\/span>/i,
    /id="[^"]*lblScopeOfWork[^"]*"[^>]*>([\s\S]{10,3000}?)<\/span>/i,
    // Generic label/value fallback
    /Description\s*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{20,2000}?)<\/(?:td|div|span)/i,
    /Comments\s*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{20,2000}?)<\/(?:td|div|span)/i,
    /Scope[^<]*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{20,2000}?)<\/(?:td|div|span)/i,
  ]);

  // ── Contact information ──────────────────────────────────────────────────
  // Ionwave supplier portal IDs: lblContactName, lnkEmail, lblPhoneNumber, lblWorkgroupName
  const contactName = extract(html, [
    /id="[^"]*lblContactName[^"]*"[^>]*>([^<]{5,100})</i,
    /Contact\s*Name[^<]*<\/[^>]+>\s*<[^>]*>\s*([A-Za-z\s,\.]{5,80}?)<\//i,
    /Buyer\s*Name[^<]*<\/[^>]+>\s*<[^>]*>\s*([A-Za-z\s,\.]{5,80}?)<\//i,
  ]);

  const contactEmail = extract(html, [
    /id="[^"]*lnkEmail[^"]*"[^>]*href="mailto:([^"?]+)/i,
    /mailto:([^"?@\s]{1,80}@[^"?\s]{1,80})"/i,
    /Contact\s*Email[^<]*<\/[^>]+>\s*<[^>]*>\s*([^\s<@]+@[^\s<]{4,60})/i,
  ]);

  const contactPhone = extract(html, [
    /id="[^"]*lblPhoneNumber[^"]*"[^>]*>([^<]{7,30})</i,
    /Contact\s*Phone[^<]*<\/[^>]+>\s*<[^>]*>\s*([^<]{7,30})</i,
  ]);

  const agency = extract(html, [
    /id="[^"]*lblWorkgroupName[^"]*"[^>]*>([^<]{3,100})</i,
    /id="[^"]*lblAgency[^"]*"[^>]*>([^<]{3,100})</i,
    /id="[^"]*lblBuyerName[^"]*"[^>]*>([^<]{3,100})</i,
  ]);

  const closeDate = extract(html, [
    /id="[^"]*lblClose[^"]*"[^>]*>([^<]{5,60})</i,
    /id="[^"]*lblCloseDate[^"]*"[^>]*>([^<]{5,60})</i,
  ]);

  // ── Required documents ───────────────────────────────────────────────────
  const docMatches = [...html.matchAll(/href="[^"]*(?:Download|Document|Attachment)[^"]*"[^>]*>([^<]{3,100})</gi)];
  const documents = [...new Set(docMatches.map(m => clean(m[1])).filter(d => d.length > 3 && !/^\s*$/.test(d)))];

  // ── Pre-bid meeting ──────────────────────────────────────────────────────
  const preBid = extract(html, [
    /Pre[- ]?[Bb]id[^<]*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{10,300}?)<\/(?:td|div)/i,
    /Pre[- ]?[Pp]roposal[^<]*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{10,300}?)<\/(?:td|div)/i,
  ]);

  return { description, documents, contactName, contactEmail, contactPhone, agency, closeDate, preBid };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const bidID = (event.queryStringParameters?.bidID || '').replace(/[^0-9]/g, '');
  if (!bidID) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'bidID required' }) };

  const url = `${DETAIL_BASE}?bidID=${bidID}&SourceType=1`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error('Detail page HTTP ' + res.status);
    const html = await res.text();
    const detail = parseDetail(html);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, bidID, url, ...detail }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, bidID, error: e.message, description: null, documents: [], contactName: null, contactEmail: null, contactPhone: null, agency: null }),
    };
  }
};
