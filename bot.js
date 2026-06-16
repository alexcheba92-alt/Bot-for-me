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
  intervalMs: 300000,
  maxCycleTimeMs: 20000
};

if (!fs.existsSync('./out')) fs.mkdirSync('./out');

let seen = new Set();
if (fs.existsSync(CONFIG.seenPath)) {
  try {
    seen = new Set(JSON.parse(fs.readFileSync(CONFIG.seenPath, 'utf8')));
  } catch {}
}

let isRunning = false;

const log = (...a) =>
  console.log(`[${new Date().toISOString()}]`, ...a);

async function tg(text) {
  if (!CONFIG.tgToken) return;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (e) {
    log('TG ERROR:', e.message);
  }
}

// validation against fake / dead pages
async function isValid(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      validateStatus: () => true
    });

    const t = (res.data || '').toString().toLowerCase();

    if (res.status !== 200) return false;
    if (t.includes('nicht gefunden')) return false;
    if (t.includes('veraltete adresse')) return false;

    return true;
  } catch {
    return false;
  }
}

async function cycle() {
  if (isRunning) {
    log('SKIP: previous cycle still running');
    return;
  }

  isRunning = true;
  const start = Date.now();

  let browser;

  try {
    log('START CYCLE');

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    // LOGIN
    await page.goto(CONFIG.loginUrl);
    await page.fill('input[type="email"]', CONFIG.login);
    await page.fill('input[type="password"]', CONFIG.password);
    await Promise.all([
      page.waitForNavigation().catch(() => {}),
      page.click('button[type="submit"]')
    ]);

    // FINDER
    await page.goto(CONFIG.finderUrl);

    await page.waitForSelector('a[href*="/expose/"]', { timeout: 20000 });
    await page.waitForTimeout(4000); // hydration stabilisation

    const links = await page.$$eval('a[href*="/expose/"]', els =>
      [...new Set(
        els
          .filter(e => e.offsetParent !== null)
          .map(e => e.href)
      )]
    );

    log(`FOUND LINKS: ${links.length}`);

    let newCount = 0;

    for (const url of links) {
      if (seen.has(url)) continue;

      const ok = await isValid(url);
      if (!ok) {
        log('INVALID:', url);
        continue;
      }

      seen.add(url);
      fs.writeFileSync(CONFIG.seenPath, JSON.stringify([...seen]));

      await tg(`🏠 <b>Neue Wohnung gefunden</b>\n🔗 ${url}`);
      newCount++;
    }

    const duration = Date.now() - start;
    log(`CYCLE DONE | new: ${newCount} | time: ${duration}ms`);

    if (duration > CONFIG.maxCycleTimeMs) {
      await tg(`⚠️ <b>WARNING</b>\nSlow cycle detected: ${duration}ms`);
    }

  } catch (e) {
    log('ERROR:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    isRunning = false;
  }
}

// scheduler (safe)
setInterval(cycle, CONFIG.intervalMs);
cycle();
