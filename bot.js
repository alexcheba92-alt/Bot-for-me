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
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
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
  const buttons = [
    'button:has-text("Alle akzeptieren")',
    '#uc-btn-accept-banner',
    'button:has-text("Accept all")',
    'button:has-text("Akzeptieren")'
  ];
  for (const sel of buttons) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count()) {
        await loc.click({ timeout: 3000 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function login(page) {
  await page.goto('https://www.inberlinwohnen.de/login/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  await acceptCookies(page);

  const email = page.locator('input[type="email"], input[name="email"]').first();
  const pass = page.locator('input[type="password"], input[name="password"]').first();

  await email.waitFor({ state: 'visible', timeout: 20000 });
  await pass.waitFor({ state: 'visible', timeout: 20000 });

  await email.fill(INBERLIN_EMAIL);
  await pass.fill(INBERLIN_PASSWORD);

  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    submit.click()
  ]);

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);
}

async function openFinder(page) {
  await page.goto('https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);
}

async function debugDump(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(OUT, `${name}.html`), await page.content());
  fs.writeFileSync(path.join(OUT, `${name}.txt`), await page.locator('body').innerText().catch(() => ''));
}

async function switchToList(page) {
  const candidates = [
    'button[aria-label*="List"]',
    'button:has-text("Liste")',
    '.aria-icon-list',
    '[class*="list"]',
    'button:has(svg)'
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count()) {
        await loc.click({ timeout: 3000 });
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {}
  }
  return false;
}

async function collectListings(page) {
  return await page.evaluate(() => {
    const out = [];
    const seen = new Set();

    const items = Array.from(document.querySelectorAll('a, article, li, div'));
    for (const el of items) {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length < 25) continue;

      const hasPrice = /€/.test(t);
      const hasRooms = /\b\d+(?:[.,]\d+)?\s*Zimmer\b/i.test(t);
      const hasArea = /\b\d+(?:[.,]\d+)?\s*m²\b/i.test(t);

      if ((hasPrice && hasRooms) || (hasRooms && hasArea)) {
        const a = el.querySelector('a[href]');
        const href = a ? a.href : (el.href || '');
        const key = `${t.slice(0, 220)}|${href}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ text: t, href });
        }
      }
    }
    return out;
  });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    ...devices['iPhone 13 Pro'],
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    viewport: { width: 393, height: 852 }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    await sendTelegram('Бот стартовал, иду проверять объявления.');

    await login(page);
    await openFinder(page);

    await switchToList(page);
    await debugDump(page, 'step_1_finder');

    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText().catch(() => '');

    console.log('TITLE:', title);
    console.log('BODY HEAD:', body.slice(0, 1200));

    const cards = await collectListings(page);

    if (!cards.length) {
      await debugDump(page, 'step_2_nocards');
      await sendTelegram('Страница открылась, но карточки не распознаны. Смотри output/step_1_finder.html и .png.');
      return;
    }

    const top = cards.slice(0, 7).map((x, i) => {
      const txt = x.text.replace(/\s+/g, ' ').slice(0, 280);
      return `${i + 1}. ${txt}${x.href ? `\n${x.href}` : ''}`;
    }).join('\n\n');

    fs.writeFileSync(path.join(OUT, 'listings.json'), JSON.stringify(cards, null, 2));
    await sendTelegram(`Найдено объявлений: <b>${cards.length}</b>\n\n${top}`);
  } catch (e) {
    await debugDump(page, 'error_state');
    console.error(e);
    await sendTelegram(`Ошибка: ${e.message}`);
  } finally {
    await browser.close();
  }
}

main().catch(async (e) => {
  console.error(e);
  await sendTelegram(`Fatal: ${e.message}`);
});

