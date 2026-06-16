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
  intervalMs: 300000,

  loginUrl: 'https://www.inberlinwohnen.de/login/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',

  outDir: path.join(__dirname, 'out'),
  seenPath: path.join(__dirname, 'out/seen.json')
};

if (!fs.existsSync(CONFIG.outDir)) {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
}

/* =========================
   STATE
========================= */
let seen = new Set();
if (fs.existsSync(CONFIG.seenPath)) {
  try {
    seen = new Set(JSON.parse(fs.readFileSync(CONFIG.seenPath, 'utf8')));
  } catch {}
}

function saveState() {
  fs.writeFileSync(CONFIG.seenPath, JSON.stringify([...seen]));
}

/* =========================
   LOG
========================= */
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(CONFIG.outDir, 'bot.log'), line + '\n');
};

/* =========================
   TG
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
   EXTRACT FROM LIST PAGE
========================= */
async function extractFromList(page) {
  return await page.evaluate(() => {
    const items = [];

    document.querySelectorAll('a[href*="expose"]').forEach(a => {
      const parent = a.closest('div, li, article') || a;
      const text = parent.textContent.replace(/\s+/g, ' ').trim();

      const match = a.href.match(/expose\/(\d+)/);
      if (!match) return;

      items.push({
        id: match[1],
        text: text.slice(0, 200)
      });
    });

    return items;
  });
}

/* =========================
   MAIN
========================= */
async function run() {
  log('🚀 START CYCLE');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const ctx = await browser.newContext({
    ...devices['iPhone 13 Pro'],
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin'
  });

  const page = await ctx.newPage();

  try {
    /* ================= LOGIN ================= */
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

    /* ================= FINDER ================= */
    log('OPEN FINDER...');
    await page.goto(CONFIG.finderUrl, { waitUntil: 'networkidle' });

    const miete = page.locator('input[name*="miete_bis"]').last();

    if (await miete.isVisible().catch(() => false)) {
      await miete.fill('600');
      await page.locator('input[name*="zimmer_von"]').first().fill('3');
      await page.locator('input[name*="zimmer_bis"]').first().fill('3');

      await page.click('button:has-text("Wohnung suchen"), button[type="submit"]').catch(() => {});
      await page.waitForTimeout(8000);
    }

    /* ================= LIST SOURCE OF TRUTH ================= */
    log('EXTRACT LIST...');

    const flats = await extractFromList(page);

    log(`FOUND IN LIST: ${flats.length}`);

    if (!flats.length) {
      log('EMPTY RESULT (LIST)');
      return;
    }

    /* ================= FILTER NEW ================= */
    const alerts = [];

    for (const f of flats) {
      if (seen.has(f.id)) continue;

      seen.add(f.id);

      alerts.push(
        `🏠 <b>Neue Wohnung gefunden</b>\n` +
        `📝 ${f.text}\n` +
        `🔗 https://www.inberlinwohnen.de/expose/${f.id}/`
      );
    }

    if (alerts.length) {
      saveState();

      for (const a of alerts) {
        await tg(a);
        await new Promise(r => setTimeout(r, 1500));
      }

      log(`SENT: ${alerts.length}`);
    } else {
      log('NO NEW ITEMS');
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
