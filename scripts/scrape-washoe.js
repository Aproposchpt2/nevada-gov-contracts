'use strict';
/* Washoe County School District (Reno) solicitations connector. Real,
   verified 2026-08-21: solicitations.washoeschools.net/Purchasing is a
   public, no-login ASP.NET WebForms GridView (id "grdUpcomingBids") --
   45 real, current solicitations found on first check, more than NGEM
   and NevadaePro combined. Server-rendered, no JavaScript execution
   needed to see the list.

   v1 scope, deliberately: list-level discovery only (project number,
   title, three dates, status). Full RFP description text lives behind
   a __doPostBack detail view (ASP.NET WebForms postback, same shape as
   NGEM's Bid Events flow) -- not built yet. The list title itself is
   real, substantive text (often 40-90+ characters) and is used as the
   requirements/scope text for v1, honestly labeled as list-only in
   qa_notes rather than presented as a full RFP description. */

const fs = require('fs');
const path = require('path');

const BASE = 'https://solicitations.washoeschools.net';
const LIST_URL = `${BASE}/Purchasing`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}
function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function fetchList() {
  const res = await fetch(LIST_URL, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error('List fetch failed: ' + res.status);
  return res.text();
}

function parseRows(html) {
  const rowRe = /<tr class=" projecttype-[\s\S]*?<\/tr>/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(html))) {
    const block = m[0];
    const projectTypeMatch = block.match(/txtProjectType"\s+id="[^"]*"\s+value="([^"]*)"/);
    const numberMatch = block.match(/lblProjectNumber_\d+">([^<]*)</);
    const postbackMatch = block.match(/__doPostBack\(&#39;([^&]*)&#39;/);
    const cells = [...block.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => stripTags(c[1]));
    if (cells.length < 6) continue;
    const [, title, preBid, questionDeadline, dueDate, status] = cells;
    if (!numberMatch) continue;
    rows.push({
      project_number: decodeEntities(numberMatch[1]).trim(),
      project_type: projectTypeMatch ? decodeEntities(projectTypeMatch[1]).trim() : null,
      title,
      pre_bid_date: preBid,
      question_deadline: questionDeadline,
      due_date: dueDate,
      status,
      postback_target: postbackMatch ? decodeEntities(postbackMatch[1]) : null,
    });
  }
  return rows;
}

async function main() {
  console.log('[scrape-washoe] loading Washoe County SD solicitations list...');
  const html = await fetchList();
  const rows = parseRows(html);
  console.log('[scrape-washoe] list loaded:', rows.length, 'solicitations');

  const out = { scraped_at: new Date().toISOString(), solicitations: rows };
  fs.writeFileSync(path.join(__dirname, '..', 'washoe.json'), JSON.stringify(out, null, 2));
  console.log('[scrape-washoe] WROTE washoe.json —', rows.length, 'solicitations.');
}

main().catch(e => { console.error('[scrape-washoe] FATAL:', e.message); process.exit(1); });
