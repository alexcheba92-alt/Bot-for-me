'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');

const CONFIG = {
  login: process.env.INBERLIN_EMAIL,
  password: process.env.INBERLIN_PASSWORD,
  tgToken: process.env.TELEGRAM_TOKEN,
  tgChatId: process.env.TELEGRAM_CHAT_ID,

  loginUrl: 'https://www.inberlinwohnen.de/login/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',

  seenPath: './out/seen_links.json',
  intervalMs: 300000
};

if (!fs.existsSync('./out')) fs.mkdirSync('./out');

let seen = new Set();
if (fs.existsSync(CONFIG.seenPath)) {
  try {
    seen = new Set(JSON.parse(fs.readFileSync(CONFIG.seenPath)));
  } catch {}
}

let running = false;

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    log('NAV WARN:', e.message);
  }
}

async function login(page) {
  log('LOGIN...');

  await safeGoto(page, CONFIG.loginUrl);

  const email = page.locator('input[type="email"], input[name="email"]').first();
  const pass = page.locator('input[type="password"]').first();

  await email.waitFor({ state: 'visible', timeout: 20000 });

  await email.fill(CONFIG.login);
  await pass.fill(CONFIG.password);

  await page.click('button[type="submit"]').catch(() => {});

  // ждём не навигацию, а факт появления внутреннего контента
  await page.waitForSelector('a[href*="/expose/"], body', { timeout: 30000 });

  log('LOGIN DONE');
}

async function extractLinks(page) {
  await safeGoto(page, CONFIG.finderUrl);

  // ждём именно данные, не сеть
  await page.waitForSelector('a[href*="/expose/"]', { timeout: 30000 });

  await page.waitForTimeout(5000);

  const links = await page.$$eval('a[href*="/expose/"]', els =>
    [...new Set(
      els
        .filter(e => e.offsetParent !== null)
        .map(e => e.href)
    )]
  );

  return links;
}

async function validate(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      validateStatus: () => true
    });

    const text = (res.data || '').toString().toLowerCase();

    if (res.status !== 200) return false;
    if (text.includes('nicht gefunden')) return false;
    if (text.includes('veraltete adresse')) return false;

    return true;
  } catch {
    return false;
  }
}

async function run() {
  if (running) return;
  running = true;

  log('START CYCLE');

  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage();

  try {
    await login(page);

    const links = await extractLinks(page);

    log('FOUND LINKS:', links.length);

    for (const url of links) {
      if (seen.has(url)) continue;

      const ok = await validate(url);
      if (!ok) continue;

      seen.add(url);
      fs.writeFileSync(CONFIG.seenPath, JSON.stringify([...seen]));

      await tg(`🏠 New flat\n🔗 ${url}`);
      log('SENT:', url);
    }

  } catch (e) {
    log('CYCLE ERROR:', e.message);
  } finally {
    await browser.close().catch(() => {});
    running = false;
    log('CYCLE END');
  }
}

run();
setInterval(run, CONFIG.intervalMs);
