// One-off: log in, navigate to the "Job Order Contracting Services" bid
// (2026-023, one of our 12 known Clark County bids) via the authenticated
// Bid Events list, follow it to VResponseAttachments.aspx, and dump the
// real document link structure there.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const USERNAME = process.env.NGEM_LOGIN_USERNAME;
const PASSWORD = process.env.NGEM_LOGIN_PASSWORD;
const TARGET_TITLE = 'Job Order Contracting Services';

async function waitOutCloudflare(page, maxAttempts = 6) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const t = await page.title();
    if (!/just a moment/i.test(t)) return;
    await page.waitForTimeout(5000);
  }
}

async function main() {
  if (!USERNAME || !PASSWORD) throw new Error('NGEM_LOGIN_USERNAME / NGEM_LOGIN_PASSWORD not set.');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 950 }, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const page = await ctx.newPage();

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
    console.log('[recon] logged in, at:', page.url());

    const navLinks = await page.$$eval('a', els => els.map(el => ({ text: (el.textContent || '').trim(), href: el.href })).filter(x => x.text));
    const bidEventsLink = navLinks.find(l => /bid\s*events/i.test(l.text));
    await page.goto(bidEventsLink.href, { waitUntil: 'networkidle', timeout: 25000 });
    await waitOutCloudflare(page);
    console.log('[recon] Bid Events:', page.url());

    // Find the row for our target bid and click its detail link.
    const rowHandle = await page.evaluateHandle((title) => {
      const rows = [...document.querySelectorAll('table tbody tr')];
      return rows.find(tr => tr.textContent.includes(title)) || null;
    }, TARGET_TITLE);
    const rowEl = rowHandle.asElement();
    if (!rowEl) throw new Error(`Row for "${TARGET_TITLE}" not found in Bid Events list.`);
    const link = await rowEl.$('a');
    if (!link) throw new Error('No link found in the target row.');
    const detailHref = await link.getAttribute('href');
    console.log('[recon] target bid detail link:', detailHref);
    await page.goto(detailHref, { waitUntil: 'networkidle', timeout: 25000 });
    await waitOutCloudflare(page);
    console.log('[recon] detail page:', page.url(), '|', await page.title());
    fs.writeFileSync('recon-jobsite-detail.html', await page.content());
    await page.screenshot({ path: 'recon-jobsite-detail.png', fullPage: true }).catch(() => {});

    const attachmentsLink = await page.$('a:has-text("Response Attachments"), a:has-text("Attachments")');
    if (!attachmentsLink) {
      console.log('[recon] no attachments link found on detail page.');
      return;
    }
    const attachHref = await attachmentsLink.getAttribute('href');
    console.log('[recon] navigating to attachments page:', attachHref);
    await page.goto(attachHref, { waitUntil: 'networkidle', timeout: 25000 });
    await waitOutCloudflare(page);
    console.log('[recon] attachments page:', page.url(), '|', await page.title());
    fs.writeFileSync('recon-jobsite-attachments.html', await page.content());
    await page.screenshot({ path: 'recon-jobsite-attachments.png', fullPage: true }).catch(() => {});

    const allLinks = await page.$$eval('a', as => as.map(a => ({ text: a.textContent.trim(), href: a.href, id: a.id })).filter(x => x.text || x.href));
    const rows = await page.$$eval('table tbody tr', trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()))).catch(() => []);
    fs.writeFileSync('recon-jobsite-attachments-data.json', JSON.stringify({ links: allLinks, rows }, null, 2));
    console.log('[recon] attachment page links:', allLinks.length, '| table rows:', rows.length);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[recon] FAILED:', e.message); process.exit(1); });
