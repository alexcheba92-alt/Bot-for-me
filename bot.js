'use strict';

const { chromium } = require('playwright');
const axios = require('axios');

const CONFIG = {
  login: process.env.INBERLIN_EMAIL,
  password: process.env.INBERLIN_PASSWORD,
  tgToken: process.env.TELEGRAM_TOKEN,
  tgChatId: process.env.TELEGRAM_CHAT_ID,

  loginUrl: 'https://www.inberlinwohnen.de/login/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',
};

async function tg(msg) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text: msg.slice(0, 3900),
    });
  } catch {}
}

let found = [];

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('START');

  /* ================= CAPTURE API ================= */

  page.on('response', async (res) => {
    try {
      const url = res.url();

      // 🔥 ловим ВСЕ возможные API запросы
      if (
        url.includes('api') ||
        url.includes('search') ||
        url.includes('wohnung') ||
        url.includes('listing')
      ) {
        const json = await res.json().catch(() => null);

        if (json) {
          found.push(json);
          console.log('API HIT:', url);
        }
      }
    } catch {}
  });

  /* ================= LOGIN ================= */

  await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded' });

  await page.waitForTimeout(3000);

  const email = await page.$('input[type="email"], input[name*="mail"], input[name*="user"]');
  const pass = await page.$('input[type="password"]');

  if (!email || !pass) throw new Error('LOGIN NOT FOUND');

  await email.fill(CONFIG.login);
  await pass.fill(CONFIG.password);

  await page.keyboard.press('Enter');

  await page.waitForTimeout(7000);

  /* ================= OPEN FINDER ================= */

  await page.goto(CONFIG.finderUrl, { waitUntil: 'domcontentloaded' });

  await page.waitForTimeout(10000);

  await browser.close();

  /* ================= RESULT ================= */

  console.log('RAW API COUNT:', found.length);

  const flat = JSON.stringify(found, null, 2);

  if (found.length === 0) {
    await tg('⚠️ No API data captured (site is protected or encrypted)');
    return;
  }

  await tg('🏠 RAW DATA FOUND:\n' + flat.slice(0, 3500));
}

run().catch(async (e) => {
  console.log(e);
  await tg('ERROR: ' + e.message);
});
