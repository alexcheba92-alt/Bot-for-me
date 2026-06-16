'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');

const CONFIG = {
  loginUrl: 'https://www.inberlinwohnen.de/login/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',

  storagePath: './auth.json',
  seenPath: './seen.json',

  login: process.env.INBERLIN_EMAIL,
  password: process.env.INBERLIN_PASSWORD,

  tgToken: process.env.TELEGRAM_TOKEN,
  tgChatId: process.env.TELEGRAM_CHAT_ID,

  intervalMs: 300000
};

let seen = new Set();
if (fs.existsSync(CONFIG.seenPath)) {
  try {
    seen = new Set(JSON.parse(fs.readFileSync(CONFIG.seenPath)));
  } catch {}
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function tg(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text,
      parse_mode: 'HTML'
    });
  } catch (e) {
    log('TG ERROR:', e.message);
  }
}

function isBad(content, headers = {}) {
  const ct = headers['content-type'] || '';
  const cd = headers['content-disposition'] || '';

  if (ct.includes('octet-stream')) return true;
  if (cd.includes('attachment')) return true;
  if (content.length < 1000) return true;

  return false;
}

async function loginIfNeeded(page, context) {
  await page.goto(CONFIG.loginUrl, { waitUntil: 'commit' });

  const alreadyLoggedIn = !page.url().includes('login');

  if (alreadyLoggedIn) {
    log('SESSION ACTIVE (storageState works)');
    return;
  }

  log('LOGIN REQUIRED');

  await page.fill('input[type="email"], input[name="email"]', CONFIG.login);
  await page.fill('input[type="password"]', CONFIG.password);
  await page.click('button[type="submit"]');

  await page.waitForTimeout(5000);

  // 🔥 ВАЖНО: сохраняем ТОЛЬКО после успешного логина
  await context.storageState({ path: CONFIG.storagePath });

  log('SESSION SAVED');
}

async function runCycle() {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext(
    fs.existsSync(CONFIG.storagePath)
      ? { storageState: CONFIG.storagePath }
      : undefined
  );

  const page = await context.newPage();

  try {
    log('START CYCLE');

    // LOGIN / SESSION
    await loginIfNeeded(page, context);

    // FINDER
    const resp = await page.goto(CONFIG.finderUrl, { waitUntil: 'commit' });

    const headers = resp?.headers() || {};
    const content = await page.content();

    if (isBad(content, headers)) {
      throw new Error('BLOCKED_OR_INVALID_RESPONSE');
    }

    const links = await page.$$eval('a[href*="/expose/"]', els =>
      [...new Set(
        els
          .filter(e => e.offsetParent !== null)
          .map(e => e.href)
      )]
    );

    log('FOUND:', links.length);

    for (const url of links) {
      if (seen.has(url)) continue;

      seen.add(url);
      fs.writeFileSync(CONFIG.seenPath, JSON.stringify([...seen]));

      await tg(`🏠 <b>New flat</b>\n${url}`);
    }

  } catch (e) {
    log('ERROR:', e.message);
  } finally {
    await browser.close();
  }
}

setInterval(runCycle, CONFIG.intervalMs);
runCycle();
