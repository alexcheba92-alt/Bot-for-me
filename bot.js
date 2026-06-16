const axios = require('axios');
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;

const OUT = path.resolve('./output');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 20000 });
  } catch (e) {
    console.error('TG error:', e.message);
  }
}

async function acceptCookies(page) {
  for (const sel of [
    'button:has-text("Alle akzeptieren")',
    '#uc-btn-accept-banner',
    'button:has-text("Accept all")',
    'button:has-text("Akzeptieren")'
  ]) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.click({ timeout: 3000 });
        return;
      }
    } catch {}
  }
}

async function login(page) {
  await page.goto('https://www.inberlinwohnen.de/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await acceptCookies(page);

  await page.locator('input[type="email"], input[name="email"]').first().fill(INBERLIN_EMAIL);
  await page.locator('input[type="password"], input[name="password"]').first().fill(INBERLIN_PASSWORD);

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.locator('button[type="submit"], input[type="submit"]').first().click()
  ]);

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);
}

async function openFinder(page) {
  const apiHits = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    if (resp.request().resourceType() === 'xhr' || resp.request().resourceType() === 'fetch') {
      apiHits.push({ url, status: resp.status(), ct });
      console.log('XHR:', resp.status(), ct, url);

      if (ct.includes('application/json')) {
        try {
          const txt = await resp.text();
          fs.writeFileSync(path.join(OUT, 'last_json.txt'), txt);
        } catch {}
      }
    }
  });

  await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(5000);

  fs.writeFileSync(path.join(OUT, 'api_hits.json'), JSON.stringify(apiHits, null, 2));
  fs.writeFileSync(path.join(OUT, 'finder.html'), await page.content());
  fs.writeFileSync(path.join(OUT, 'finder.txt'), await page.locator('body').innerText().catch(() => ''));

  await page.screenshot({ path: path.join(OUT, 'finder.png'), fullPage: true }).catch(() => {});
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    ...devices['iPhone 13 Pro'],
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin'
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    await sendTelegram('Старт диагностики API и списка квартир.');
    await login(page);
    await openFinder(page);

    const body = await page.locator('body').innerText().catch(() => '');
    const match = body.match(/(\d+)\s+Wohnungen|(\d+)\s+Angeboten|(\d+)\s+Objekten/i);

    await sendTelegram(
      match
        ? `Страница открылась. Текст счётчика найден: <b>${match[0]}</b>. Смотри output/api_hits.json и finder.*`
        : 'Страница открылась, но счётчик не найден. Смотри output/api_hits.json и finder.*'
    );
  } catch (e) {
    await sendTelegram(`Ошибка: ${e.message}`);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
