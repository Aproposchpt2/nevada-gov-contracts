// One-off: real NGEM login using the stored vendor credentials, then check
// whether an authenticated session can actually see/download a document
// that's flagged requires_login:true for an anonymous session. Tests
// against bid 20387 (Mini Warehouse Storage Unit Demolition), which has a
// confirmed-gated PDF attachment from the last anonymous scrape.
// Credentials from GitHub Actions secrets (NGEM_LOGIN_USERNAME /
// NGEM_LOGIN_PASSWORD) -- never printed.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const USERNAME = process.env.NGEM_LOGIN_USERNAME;
const PASSWORD = process.env.NGEM_LOGIN_PASSWORD;
const TEST_BID_ID = '20387';

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
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 }, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    });
    const page = await ctx.newPage();

    console.log('[test] navigating to Login.aspx...');
    await page.goto('https://nevada.ionwave.net/Login.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitOutCloudflare(page);
    console.log('[test] at:', page.url(), '|', await page.title());

    await page.fill('#txtUserName', USERNAME);
    await page.fill('#txtPassword', PASSWORD);

    // The "I agree to terms" checkbox may or may not be required/present --
    // click it defensively if it exists and isn't already checked.
    const agreeBox = await page.$('#chkAgree');
    if (agreeBox) {
      const isChecked = await agreeBox.evaluate(el => el.getAttribute('aria-checked') === 'true' || el.classList.contains('checked')).catch(() => false);
      if (!isChecked) { await agreeBox.click().catch(() => {}); console.log('[test] clicked terms checkbox'); }
    }

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {}),
      page.click('#btnLogin'),
    ]);
    await page.waitForTimeout(3000);
    await waitOutCloudflare(page);

    const postLoginUrl = page.url();
    const postLoginTitle = await page.title();
    console.log('[test] after login, url:', postLoginUrl, '| title:', postLoginTitle);
    const loggedIn = !/login\.aspx/i.test(postLoginUrl);
    fs.writeFileSync('ngem-test-post-login.json', JSON.stringify({ url: postLoginUrl, title: postLoginTitle, loggedIn }, null, 2));
    await page.screenshot({ path: 'ngem-test-post-login.png', fullPage: true }).catch(() => {});

    if (!loggedIn) {
      console.log('[test] LOGIN DID NOT SUCCEED -- stopping here.');
      fs.writeFileSync('ngem-test-login-failure.html', await page.content());
      return;
    }
    console.log('[test] LOGIN SUCCEEDED. Exploring the authenticated vendor portal for the real bid search...');

    const navLinks = await page.$$eval('a, [role=link]', els => els.map(el => ({ text: (el.textContent || '').trim(), href: el.href || null })).filter(x => x.text));
    fs.writeFileSync('ngem-test-dashboard-nav.json', JSON.stringify(navLinks, null, 2));

    const bidEventsLink = navLinks.find(l => /bid\s*events/i.test(l.text));
    if (bidEventsLink && bidEventsLink.href) {
      console.log('[test] navigating to Bid Events:', bidEventsLink.href);
      await page.goto(bidEventsLink.href, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
      await waitOutCloudflare(page);
      console.log('[test] Bid Events page:', page.url(), '|', await page.title());
      await page.screenshot({ path: 'ngem-test-bid-events.png', fullPage: true }).catch(() => {});

      // Try a search box for the known bid title.
      const searchBox = await page.$('input[type=search], input[placeholder*=Search i], input[id*=Search i]');
      if (searchBox) {
        await searchBox.fill('Mini Warehouse Storage Unit Demolition');
        await page.waitForTimeout(2500);
        console.log('[test] searched for the test bid title');
      } else {
        console.log('[test] no obvious search box found on Bid Events page');
      }
      const rows = await page.$$eval('table tbody tr', trs => trs.slice(0, 40).map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()))).catch(() => []);
      fs.writeFileSync('ngem-test-bid-events-rows.json', JSON.stringify(rows, null, 2));
      console.log('[test] Bid Events row count (after search):', rows.length);
      if (rows.length) console.log('[test] sample row:', JSON.stringify(rows[0]));
      await page.screenshot({ path: 'ngem-test-bid-events-search.png', fullPage: true }).catch(() => {});

      // If a row links to a bid detail, follow the first one to inspect its
      // real document/attachment structure inside the authenticated app.
      const detailLink = await page.$('table tbody tr a');
      if (detailLink) {
        const href = await detailLink.getAttribute('href');
        console.log('[test] following first result link:', href);
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
          detailLink.click(),
        ]);
        await page.waitForTimeout(2000);
        await waitOutCloudflare(page);
        console.log('[test] detail page:', page.url(), '|', await page.title());
        fs.writeFileSync('ngem-test-authenticated-bid-detail.html', await page.content());
        await page.screenshot({ path: 'ngem-test-authenticated-bid-detail.png', fullPage: true }).catch(() => {});
        const docLinks = await page.$$eval('a', as => as.map(a => ({ text: a.textContent.trim(), href: a.href })).filter(x => /\.(pdf|docx?|xlsx?|zip)(\?|$)/i.test(x.href) || /download|attach|extract/i.test(x.href)));
        fs.writeFileSync('ngem-test-authenticated-doc-links.json', JSON.stringify(docLinks, null, 2));
        console.log('[test] document-like links found on authenticated detail page:', docLinks.length);
      }
    } else {
      console.log('[test] no Bid Events link found in nav.');
    }

    console.log('[test] DONE.');
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[test] FAILED:', e.message); process.exit(1); });
