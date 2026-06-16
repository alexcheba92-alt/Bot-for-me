'use strict';

const { chromium, devices } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  login: process.env.INBERLIN_EMAIL || '',
  password: process.env.INBERLIN_PASSWORD || '',
  tgToken: process.env.TELEGRAM_TOKEN || '',
  tgChatId: process.env.TELEGRAM_CHAT_ID || '',
  intervalMs: Number(process.env.INTERVAL_MS || 300000),

  loginUrl: 'https://www.inberlinwohnen.de/login/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',

  outDir: path.join(__dirname, 'out'),
  seenPath: path.join(__dirname, 'out/seen.json'),
  maxStore: 5000
};

if (!fs.existsSync(CONFIG.outDir)) fs.mkdirSync(CONFIG.outDir, { recursive: true });

/* =========================
   STATE STORE (SAFE)
========================= */
let seen = new Set();
if (fs.existsSync(CONFIG.seenPath)) {
  try { seen = new Set(JSON.parse(fs.readFileSync(CONFIG.seenPath, 'utf8'))); } catch {}
}

function saveSeen() {
  fs.writeFileSync(CONFIG.seenPath, JSON.stringify([...seen]));
}

/* =========================
   LOGGING
========================= */
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(CONFIG.outDir, 'bot.log'), line + '\n');
};

/* =========================
   TELEGRAM
========================= */
async function tg(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text: String(text).slice(0, 3900),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (e) {
    log('TG ERROR:', e.message);
  }
}

/* =========================
   SAFE TEXT EXTRACTOR
========================= */
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/* =========================
   ID EXTRACTOR (ROBUST)
========================= */
function extractIds(text) {
  const ids = new Set();

  const patterns = [
    /expose\/(\d{4,})/g,
    /"wubID"\s*:\s*"?(\d{4,})"?/g,
    /"id"\s*:\s*"?(\d{4,})"?/g,
    /id=(\d{4,})/g
  ];

  for (const p of patterns) {
    const matches = [...text.matchAll(p)];
    for (const m of matches) ids.add(m[1]);
  }

  return [...ids];
}

/* =========================
   MAIN RUN
========================= */
async function run() {
  log('🚀 START CYCLE');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox'
    ]
  });

  const ctx = await browser.newContext({
    ...devices['iPhone 13 Pro'],
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin'
  });

  const page = await ctx.newPage();

  const cycleIds = new Set();
  let blocked = false;

  /* =========================
     READ-ONLY SNiffer (SAFE)
  ========================= */
  page.on('response', async (res) => {
    try {
      const status = res.status();
      if ([403, 429, 503].includes(status)) blocked = true;

      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('text') && !ct.includes('json') && !ct.includes('html')) return;

      const text = await safeText(res);
      if (!text) return;

      if (
        text.includes('captcha') ||
        text.includes('cloudflare') ||
        text.includes('blocked')
      ) blocked = true;

      const ids = extractIds(text);
      for (const id of ids) cycleIds.add(id);

    } catch {}
  });

  try {
    /* =========================
       LOGIN
    ========================= */
    log('LOGIN...');
    await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded' });

    await page.locator('button:has-text("Alle akzeptieren")').click().catch(() => {});

    const email = page.locator('input[type="email"], input[name="email"]').first();
    if (await email.isVisible().catch(() => false)) {
      await email.fill(CONFIG.login);
      await page.locator('input[type="password"]').first().fill(CONFIG.password);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
        page.click('button[type="submit"]')
      ]);
    }

    /* =========================
       FINDER
    ========================= */
    log('OPEN FINDER...');
    await page.goto(CONFIG.finderUrl, { waitUntil: 'networkidle' });

    const miete = page.locator('input[name*="miete_bis"]').last();

    if (await miete.isVisible().catch(() => false)) {
      await miete.fill('600');
      await page.locator('input[name*="zimmer_von"]').first().fill('3');
      await page.locator('input[name*="zimmer_bis"]').first().fill('3');

      await page.click('button:has-text("Wohnung suchen"), button[type="submit"]').catch(() => {});
      await page.waitForTimeout(9000);
    }

    /* =========================
       ANALYSIS
    ========================= */
    log(`FOUND RAW IDS: ${cycleIds.size}`);

    if (blocked && cycleIds.size === 0) {
      await tg('⚠️ <b>BLOCK / CAPTCHA detected</b>');
      return;
    }

    const alerts = [];

    for (const id of cycleIds) {
      if (!seen.has(id)) {
        seen.add(id);

        alerts.push(
          `🏠 <b>New flat detected</b>\n` +
          `🔗 https://www.inberlinwohnen.de/expose/${id}/`
        );
      }
    }

    if (alerts.length) {
      saveSeen();

      for (const a of alerts.slice(0, 10)) {
        await tg(a);
        await new Promise(r => setTimeout(r, 1500));
      }
    } else {
      log('NO NEW DATA');
    }

  } catch (e) {
    log('ERROR:', e.message);
  } finally {
    await browser.close().catch(() => {});
    log('CYCLE END');
  }
}

/* =========================
   LOOP
========================= */
(async () => {
  log('BOT STARTED');

  if (!CONFIG.login || !CONFIG.password) {
    log('NO CREDS');
    process.exit(1);
  }

  await run();

  setInterval(run, CONFIG.intervalMs);
})();
