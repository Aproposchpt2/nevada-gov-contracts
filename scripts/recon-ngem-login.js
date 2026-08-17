// One-off: dump the real NGEM (nevada.ionwave.net) Login.aspx form fields
// so the real login script is written against verified selectors, not
// guesses. Reuses the stealth Cloudflare-wait pattern already proven in
// scrape-ngem.js. Not part of the regular pipeline -- delete once the real
// login flow is built and confirmed working.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function main() {
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

    console.log('[recon] navigating to https://nevada.ionwave.net/Login.aspx ...');
    await page.goto('https://nevada.ionwave.net/Login.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
    let title = await page.title();
    if (/just a moment/i.test(title)) {
      console.log('[recon] Cloudflare challenge detected, waiting...');
      for (let attempt = 0; attempt < 6; attempt++) {
        const t = await page.title();
        if (!/just a moment/i.test(t)) break;
        await page.waitForTimeout(5000);
      }
      title = await page.title();
    }
    console.log('[recon] final url:', page.url(), '| title:', title);

    const inputs = await page.$$eval('input, select', els => els.map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id, placeholder: el.placeholder,
    })));
    const buttons = await page.$$eval('button, input[type=submit], input[type=button]', els => els.map(el => ({
      tag: el.tagName, type: el.type, text: (el.textContent || el.value || '').trim(), id: el.id, name: el.name,
    })));
    fs.writeFileSync('recon-ngem-login-form.json', JSON.stringify({ url: page.url(), title, inputs, buttons }, null, 2));
    console.log('[recon] wrote recon-ngem-login-form.json —', inputs.length, 'inputs/selects,', buttons.length, 'buttons');

    fs.writeFileSync('recon-ngem-login-page.html', await page.content());
    await page.screenshot({ path: 'recon-ngem-login-page.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[recon] FAILED:', e); process.exit(1); });
