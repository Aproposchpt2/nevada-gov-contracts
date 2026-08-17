// One-off: exhaustive check of whether Clark County's Bonfire portal
// carries any of the 12 known Clark County NGEM bids, across all three
// portal tabs (Open / Past / My Opportunities), by BOTH searching each
// known title AND dumping the full unfiltered row list per tab so a
// search-box quirk can't produce a false negative.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EMAIL = process.env.CLARK_COUNTY_BONFIRE_EMAIL;
const PASSWORD = process.env.CLARK_COUNTY_BONFIRE_PASSWORD;

const KNOWN_BIDS = [
  { id: '20087', title: 'Jail Food Services', solicitation: '260180-JL' },
  { id: '20112', title: 'ARC Biohazardous, Non-Biohazardous, and Hazardous Waste Services', solicitation: '608007' },
  { id: '20179', title: 'Job Order Contracting Services', solicitation: '2026-023' },
  { id: '20229', title: 'River Mountains Reservoir Site Piping Upgrades', solicitation: '015284' },
  { id: '20255', title: 'Fleet Maintenance Bridge Crane', solicitation: 'IFB 102-27' },
  { id: '20284', title: 'South Boulevard 2745 Zone Reservoir', solicitation: '010323' },
  { id: '20310', title: 'Facility Water Management Program', solicitation: 'B-1792' },
  { id: '20313', title: 'Kiel Ranch Phase VI', solicitation: '1741' },
  { id: '20314', title: 'Nellis Industrial Park Interceptor Sewer', solicitation: '1789' },
  { id: '20328', title: 'Cadiz Storm Drain', solicitation: 'IFB 106-26' },
  { id: '20392', title: 'INVESTMENT CONSULTANT SERVICES', solicitation: 'RFP 2026-022' },
  { id: '20400', title: 'Via Nobila Trail Bridge', solicitation: 'IFB 104-27' },
];

const TABS = [
  { key: 'openOpportunities', label: 'Open Public Opportunities', linkText: 'Open Public Opportunities' },
  { key: 'pastOpportunities', label: 'Past Public Opportunities', linkText: 'Past Public Opportunities' },
  { key: 'myOpportunities', label: 'My Opportunities', linkText: 'My Opportunities' },
];

async function dumpRows(page) {
  return page.$$eval('table tbody tr', rows => rows.map(tr => {
    const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
    return cells;
  })).catch(() => []);
}

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error('CLARK_COUNTY_BONFIRE_EMAIL / CLARK_COUNTY_BONFIRE_PASSWORD not set.');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 950 } });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const page = await ctx.newPage();

    console.log('[full] logging in...');
    await page.goto('https://clarkcountynv.bonfirehub.com/login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[name=email]', EMAIL);
    await page.click('button[type=submit]');
    await page.waitForTimeout(2000);
    await page.fill('input[name=password]', PASSWORD);
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
      page.click('button[type=submit]'),
    ]);
    await page.waitForTimeout(2000);
    console.log('[full] logged in, at:', page.url());

    const report = { tabs: {}, matches: [] };

    for (const tab of TABS) {
      console.log('[full] === tab:', tab.label, '===');
      await page.goto('https://clarkcountynv.bonfirehub.com/portal', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      const link = await page.$(`text=${tab.linkText}`);
      if (link) {
        await link.click();
        await page.waitForTimeout(2000);
      } else {
        console.log('[full] tab link not found:', tab.label);
      }
      const rows = await dumpRows(page);
      report.tabs[tab.key] = { label: tab.label, rowCount: rows.length, rows: rows.slice(0, 100) };
      console.log('[full]', tab.label, '-- unfiltered row count:', rows.length);
      if (rows.length) console.log('[full] sample rows:', JSON.stringify(rows.slice(0, 5)));
    }

    // Cross-reference every known bid's title/solicitation number against
    // every row dumped from every tab (substring, case-insensitive) --
    // catches partial title matches the UI's own search box might miss.
    for (const bid of KNOWN_BIDS) {
      const titleWords = bid.title.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      let found = null;
      for (const tabKey of Object.keys(report.tabs)) {
        for (const row of report.tabs[tabKey].rows) {
          const rowText = row.join(' ').toLowerCase();
          const matchesTitle = titleWords.some(w => rowText.includes(w));
          const matchesSolicitation = bid.solicitation && rowText.includes(bid.solicitation.toLowerCase());
          if (matchesTitle || matchesSolicitation) { found = { tab: tabKey, row }; break; }
        }
        if (found) break;
      }
      report.matches.push({ ngem_id: bid.id, title: bid.title, solicitation: bid.solicitation, found: Boolean(found), foundIn: found || null });
      console.log('[full]', bid.id, bid.title, '-> found:', Boolean(found));
    }

    fs.writeFileSync('full-check-report.json', JSON.stringify(report, null, 2));
    await page.screenshot({ path: 'full-check-final.png', fullPage: true }).catch(() => {});
    console.log('[full] DONE. Total matches found:', report.matches.filter(m => m.found).length, '/', report.matches.length);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[full] FAILED:', e.message); process.exit(1); });
