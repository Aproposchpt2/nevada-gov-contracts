// One-off reconnaissance script: dump the real Clark County Bonfire login
// form's HTML/selectors so the real login script can be written against
// verified selectors instead of guesses. Not part of the regular pipeline --
// safe to delete once the real login flow is built and confirmed working.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function main() {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await ctx.newPage();

    console.log('[recon] navigating to https://clarkcountynv.bonfirehub.com/ ...');
    await page.goto('https://clarkcountynv.bonfirehub.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('[recon] goto warning:', e.message));
    console.log('[recon] landed at:', page.url());
    console.log('[recon] title:', await page.title());

    // Look for a login/sign-in link on the landing page.
    const links = await page.$$eval('a', as => as.map(a => ({ text: a.textContent.trim(), href: a.href })).filter(x => x.text));
    fs.writeFileSync('recon-landing-links.json', JSON.stringify(links, null, 2));
    console.log('[recon] wrote recon-landing-links.json,', links.length, 'links found');

    const loginLink = links.find(l => /log\s*in|sign\s*in/i.test(l.text));
    if (loginLink) {
      console.log('[recon] found login link:', loginLink.href);
      await page.goto(loginLink.href, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('[recon] login goto warning:', e.message));
    } else {
      console.log('[recon] no explicit login link found on landing page, trying /login/vendor');
      await page.goto('https://clarkcountynv.bonfirehub.com/login/vendor', { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('[recon] warning:', e.message));
    }
    console.log('[recon] login page url:', page.url());
    console.log('[recon] login page title:', await page.title());

    const inputs = await page.$$eval('input', els => els.map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, autocomplete: el.autocomplete,
    })));
    const buttons = await page.$$eval('button, input[type=submit]', els => els.map(el => ({
      tag: el.tagName, type: el.type, text: (el.textContent || el.value || '').trim(), id: el.id,
    })));
    fs.writeFileSync('recon-login-form.json', JSON.stringify({ url: page.url(), title: await page.title(), inputs, buttons }, null, 2));
    console.log('[recon] wrote recon-login-form.json —', inputs.length, 'inputs,', buttons.length, 'buttons');

    const html = await page.content();
    fs.writeFileSync('recon-login-page.html', html);
    console.log('[recon] wrote recon-login-page.html,', html.length, 'bytes');

    await page.screenshot({ path: 'recon-login-page.png', fullPage: true }).catch(e => console.log('[recon] screenshot failed:', e.message));

    // Submit the email step (using a harmless placeholder, NOT real
    // credentials -- this recon only needs to see what the NEXT step's
    // form looks like, it never needs to actually authenticate) to reveal
    // the password step's field names.
    const emailInput = await page.$('input[name=email]');
    if (emailInput) {
      await emailInput.fill('recon-only@example.com');
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
        page.click('button[type=submit]'),
      ]);
      await page.waitForTimeout(1500);
      const step2Inputs = await page.$$eval('input', els => els.map(el => ({
        tag: el.tagName, type: el.type, name: el.name, id: el.id, placeholder: el.placeholder,
      })));
      const step2Buttons = await page.$$eval('button, input[type=submit]', els => els.map(el => ({
        tag: el.tagName, type: el.type, text: (el.textContent || el.value || '').trim(), id: el.id,
      })));
      fs.writeFileSync('recon-login-step2.json', JSON.stringify({ url: page.url(), title: await page.title(), inputs: step2Inputs, buttons: step2Buttons }, null, 2));
      console.log('[recon] wrote recon-login-step2.json —', step2Inputs.length, 'inputs,', step2Buttons.length, 'buttons');
      await page.screenshot({ path: 'recon-login-step2.png', fullPage: true }).catch(() => {});
    } else {
      console.log('[recon] no email input found, skipping step 2 probe');
    }

    // Check the two currently public opportunity listings to see if their
    // titles match any of the known Clark County NGEM bids -- resolves
    // whether Bonfire actually carries the same opportunities.
    const knownIds = ['244401', '234773'];
    const opportunityTitles = [];
    for (const id of knownIds) {
      try {
        await page.goto(`https://clarkcountynv.bonfirehub.com/opportunities/${id}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        for (let attempt = 0; attempt < 6; attempt++) {
          const t = await page.title();
          if (!/just a moment/i.test(t)) break;
          await page.waitForTimeout(5000);
        }
        const finalTitle = await page.title();
        const h1 = await page.$eval('h1', el => el.textContent.trim()).catch(() => null);
        const bodyText = await page.$eval('body', el => el.innerText.slice(0, 400)).catch(() => null);
        opportunityTitles.push({ id, pageTitle: finalTitle, h1, bodyPreview: bodyText });
        console.log('[recon] opportunity', id, '->', finalTitle, '| h1:', h1);
        if (id === knownIds[0]) await page.screenshot({ path: 'recon-opportunity-244401.png', fullPage: true }).catch(() => {});
      } catch (e) {
        opportunityTitles.push({ id, error: e.message });
      }
    }
    fs.writeFileSync('recon-known-opportunities.json', JSON.stringify(opportunityTitles, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[recon] FAILED:', e); process.exit(1); });
