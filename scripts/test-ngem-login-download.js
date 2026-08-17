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
    console.log('[test] LOGIN SUCCEEDED. Checking bid', TEST_BID_ID, 'detail page for the gated document...');

    await page.goto(`https://nevada.ionwave.net/PublicDetail.aspx?bidID=${TEST_BID_ID}&SourceType=1`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitOutCloudflare(page);
    const html = await page.content();
    fs.writeFileSync('ngem-test-bid-detail.html', html);

    // Look for the attachment grid rows and whether the "please login" text
    // is still present now that we're authenticated.
    const stillGated = /please login to view/i.test(html);
    const attachmentLinks = await page.$$eval('a[href*="extract.aspx"], a[href*="Extract.aspx"]', as => as.map(a => ({ text: a.textContent.trim(), href: a.href })));
    console.log('[test] still shows "please login to view" text:', stillGated);
    console.log('[test] extract.aspx links found:', attachmentLinks.length);
    if (attachmentLinks.length) console.log('[test] sample link:', JSON.stringify(attachmentLinks[0]));

    fs.writeFileSync('ngem-test-attachments.json', JSON.stringify({ bidId: TEST_BID_ID, stillGated, attachmentLinks }, null, 2));
    await page.screenshot({ path: 'ngem-test-bid-detail.png', fullPage: true }).catch(() => {});

    console.log('[test] DONE.');
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[test] FAILED:', e.message); process.exit(1); });
