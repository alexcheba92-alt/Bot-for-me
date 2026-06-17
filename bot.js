const { chromium, devices } = require('playwright');
const axios = require('axios');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;

const CHECK_INTERVAL = 5 * 60 * 1000;
const SEEN_FILE = '/tmp/inberlin_seen.json';

let previousKeys = new Set();
let firstRun = true;
let lastSnapshot = [];

function loadState() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      previousKeys = new Set(raw.previousKeys || []);
      lastSnapshot = raw.lastSnapshot || [];
      firstRun = raw.firstRun ?? true;
    }
  } catch (e) {
    previousKeys = new Set();
    lastSnapshot = [];
    firstRun = true;
  }
}

function saveState() {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify({
      previousKeys: [...previousKeys],
      lastSnapshot,
      firstRun
    }, null, 2));
  } catch (e) {}
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.trim().replace(/\/$/, '');
  }
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendTelegram(text, url = null) {
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  if (url) {
    payload.reply_markup = {
      inline_keyboard: [[{ text: '🔗 Открыть квартиру', url }]]
    };
  }

  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload, {
    timeout: 30000
  });
}

async function loginAndOpenFinder(page) {
  await page.goto('https://www.inberlinwohnen.de/login/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.locator('button:has-text("Alle akzeptieren")').click().catch(() => {});

  const emailInput = page.locator('input[name="email"]');
  if (await emailInput.count()) {
    await emailInput.fill(INBERLIN_EMAIL);
    await page.locator('input[name="password"]').fill(INBERLIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(5000);
  }

  await page.goto('https://www.inberlinwohnen.de/wohnungsfinder/', {
    waitUntil: 'networkidle',
    timeout: 120000
  });

  await page.waitForTimeout(5000);
}

async function extractApartments(page) {
  return await page.evaluate(() => {
    const out = [];
    const seen = new Set();

    const candidates = Array.from(document.querySelectorAll('a[href]'));
    for (const a of candidates) {
      const href = (a.href || '').trim();
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();

      if (!href || !text) continue;
      if (!href.includes('inberlinwohnen.de')) continue;

      const looksLikeApartment =
        href.includes('/expose/') ||
        href.includes('/wohnungsfinder/') ||
        href.includes('wohnung') ||
        /(\bqm\b|\bzimmer\b|\bwarmmiete\b|\bkaltmiete\b)/i.test(text);

      if (!looksLikeApartment) continue;

      const key = href.replace(/\/$/, '').split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ href: key, text });
    }

    return out;
  });
}

function buildMessage(title, items) {
  const lines = [`<b>${escapeHtml(title)}</b>`, ''];
  for (const item of items) {
    lines.push(`• <b>${escapeHtml(item.title || 'Квартира')}</b>`);
    if (item.details) lines.push(`${escapeHtml(item.details)}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function checkApartments() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox']
  });

  const context = await browser.newContext({
    ...devices['iPhone 13 Pro'],
    locale: 'de-DE'
  });

  const page = await context.newPage();

  try {
    await loginAndOpenFinder(page);

    const apartments = await extractApartments(page);
    const currentKeys = new Set(apartments.map(a => normalizeUrl(a.href)));

    const added = apartments.filter(a => !previousKeys.has(normalizeUrl(a.href)));
    const removed = [...previousKeys]
      .filter(k => !currentKeys.has(k));

    if (firstRun) {
      previousKeys = currentKeys;
      lastSnapshot = apartments;
      firstRun = false;
      saveState();

      const msg = buildMessage(
        `Бот запущен. Найдено квартир: ${apartments.length}`,
        apartments.slice(0, 10).map(a => ({
          title: a.text.slice(0, 120),
          details: a.href
        }))
      );

      await sendTelegram(msg);
      return;
    }

    if (added.length === 0 && removed.length === 0) {
      console.log('Изменений нет');
      return;
    }

    const chunks = [];

    if (added.length > 0) {
      chunks.push(buildMessage(
        `Новые квартиры: ${added.length}`,
        added.map(a => ({
          title: a.text.slice(0, 120),
          details: a.href
        }))
      ));
    }

    if (removed.length > 0) {
      chunks.push(buildMessage(
        `Удалённые квартиры: ${removed.length}`,
        removed.map(href => ({
          title: 'Квартира исчезла из списка',
          details: href
        }))
      ));
    }

    for (const part of chunks) {
      const first = added[0] || apartments[0] || null;
      const buttonUrl = first ? first.href : null;
      await sendTelegram(part, buttonUrl);
    }

    previousKeys = currentKeys;
    lastSnapshot = apartments;
    saveState();
  } catch (e) {
    console.error('Ошибка проверки:', e.message);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  loadState();

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !INBERLIN_EMAIL || !INBERLIN_PASSWORD) {
    throw new Error('Не заданы TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, INBERLIN_EMAIL или INBERLIN_PASSWORD');
  }

  await checkApartments();
  setInterval(() => {
    checkApartments().catch(err => console.error('Fatal check error:', err.message));
  }, CHECK_INTERVAL);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
