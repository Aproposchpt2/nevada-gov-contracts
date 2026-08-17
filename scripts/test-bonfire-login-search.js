// One-off test: real Bonfire login using the stored vendor credentials,
// then search for one known Clark County NGEM bid by title to determine
// whether it actually exists on Bonfire too. Uses CLARK_COUNTY_BONFIRE_EMAIL
// / CLARK_COUNTY_BONFIRE_PASSWORD (GitHub Actions secrets -- never printed).
// Not part of the regular pipeline; delete once the real connector is built.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EMAIL = process.env.CLARK_COUNTY_BONFIRE_EMAIL;
const PASSWORD = process.env.CLARK_COUNTY_BONFIRE_PASSWORD;
// A representative sample of the 12 known Clark County NGEM bids -- checking
// a few, not all, to keep this test run short.
const SEARCH_TERMS = [
  'Job Order Contracting Services',
  'Jail Food Services',
  'Fleet Maintenance Bridge Crane',
];

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error('CLARK_COUNTY_BONFIRE_EMAIL / CLARK_COUNTY_BONFIRE_PASSWORD not set.');

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await ctx.newPage();

    console.log('[test] navigating to login...');
    await page.goto('https://clarkcountynv.bonfirehub.com/login', { waitUntil: 'networkidle', timeout: 30000 });
    console.log('[test] at:', page.url());

    await page.fill('input[name=email]', EMAIL);
    await page.click('button[type=submit]');
    await page.waitForTimeout(2000);

    const passwordField = await page.$('input[name=password]');
    if (!passwordField) {
      const html = await page.content();
      fs.writeFileSync('test-login-failure.html', html);
      throw new Error('Password field did not appear after submitting email -- see test-login-failure.html');
    }
    await passwordField.fill(PASSWORD);
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
      page.click('button[type=submit]'),
    ]);
    await page.waitForTimeout(3000);

    const postLoginUrl = page.url();
    const postLoginTitle = await page.title();
    console.log('[test] after login, url:', postLoginUrl, '| title:', postLoginTitle);

    const loggedIn = !/login/i.test(postLoginUrl) && !/log\s*in/i.test(postLoginTitle);
    fs.writeFileSync('test-post-login.json', JSON.stringify({ url: postLoginUrl, title: postLoginTitle, loggedIn }, null, 2));
    await page.screenshot({ path: 'test-post-login.png', fullPage: true }).catch(() => {});

    if (!loggedIn) {
      console.log('[test] LOGIN DID NOT SUCCEED -- stopping here.');
      return;
    }
    console.log('[test] login succeeded. Checking whether an authenticated session clears the opportunity-detail Cloudflare gate...');

    const results = [];
    for (const id of ['244401', '234773']) {
      await page.goto(`https://clarkcountynv.bonfirehub.com/opportunities/${id}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      for (let attempt = 0; attempt < 4; attempt++) {
        const t = await page.title();
        if (!/just a moment/i.test(t)) break;
        await page.waitForTimeout(4000);
      }
      const title = await page.title();
      const h1 = await page.$eval('h1', el => el.textContent.trim()).catch(() => null);
      const gated = /just a moment/i.test(title);
      results.push({ id, title, h1, gated });
      console.log('[test] opportunity', id, 'gated:', gated, '| title:', title, '| h1:', h1);
    }

    console.log('[test] navigating to the vendor opportunities/dashboard search...');
    await page.goto('https://clarkcountynv.bonfirehub.com/portal', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    const dashboardTitle = await page.title();
    const dashboardUrl = page.url();
    console.log('[test] dashboard:', dashboardUrl, '|', dashboardTitle);

    // Try a generic in-page search box if one exists.
    const searchBox = await page.$('input[type=search], input[placeholder*=Search i]');
    const searchMatches = {};
    if (searchBox) {
      for (const term of SEARCH_TERMS) {
        await searchBox.fill('');
        await searchBox.fill(term);
        await page.waitForTimeout(2500);
        const bodyText = await page.$eval('body', el => el.innerText).catch(() => '');
        searchMatches[term] = bodyText.toLowerCase().includes(term.toLowerCase().split(' ')[0]);
      }
    } else {
      console.log('[test] no obvious search box found on the portal page.');
    }

    fs.writeFileSync('test-search-results.json', JSON.stringify({ dashboardUrl, dashboardTitle, hadSearchBox: Boolean(searchBox), searchMatches, opportunityGateResults: results }, null, 2));
    await page.screenshot({ path: 'test-dashboard.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[test] FAILED:', e.message); process.exit(1); });
