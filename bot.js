const { chromium, devices } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INBERLIN_EMAIL = process.env.INBERLIN_EMAIL;
const INBERLIN_PASSWORD = process.env.INBERLIN_PASSWORD;

const PERSONAL_WOHNUNGSFINDER_URL = 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder?q=eyJpdiI6IkhuTjRkUVlnM0IzNHFxOEJ3SjJ1dUE9PSIsInZhbHVlIjoiQ3dTVWVUQzZoNkZnL291NXVDOSt0N0hNb3VqTE56RnE3bDM5S2h3QS9oWSt4cC96elJDZTNVWFkzaE9rN0ZmRmtpOTRPT01DWk5rVUVtSnZmMTZsWnlVYXkwNXZOMmEyYUtSNWRKaG9Sd0twTFVQOWdjZTVpWll5a2tRUW5XbkF5OFVRbnZYNnI1MjlmMmhFeS9ZeUdtY0RyL2tGZ2dnaUxobGlUWVY4ekQrcWtpSlAwVWVMSTdsRDhuVXJ6RW9ydS9aNUpkc2U0MmJmRytwSGdudDlHbFZmeWtUMkhITUxzRzM4SmRDN3ZLMzhERi9nSkc4VWxWZ01xbXY5VVdYVmcyU1BWTXhRc1NYTHBXa1lDK3dPNWp0MjVoU3JIS1R6NkhqcDUzbHpqVzRtRmF5UytXVmFaMjVDZ0JXekE4VTdFajhVQmtCT01adVQ1Z0o3SVBFNE9MS2lnMVUvWkI5cE5WYUk3b3FwcjVlKzB1cEZEQ1NPYzlvZkwxdW9uUEdraXlQUGUwL0pUdzRoNDY0RXlNTXViMzNGN1VKMXRIK2pVdEVvSVlJcjV1QVNJMUtyd0pxR2VBMXRjV2VudVNsOCIsIm1hYyI6ImEwZDYzZDFjMmU3MTc5M2Y4Y2I5YzI1ZjBhMTEyZGMwZDk5ZjlkYTNhNDcyMjkyMmE3MzA5NzY4MjE3ZjgwOWYiLCJ0YWciOiIifQ%3D%3D';

const CHECK_INTERVAL = 5 * 60 * 1000;
const STATE_FILE = '/tmp/inberlin_state.json';
const DEBUG_DIR = '/tmp/inberlin_debug';

let state = {
  seen: [],
  firstRun: true
};

function ensureDirs() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state.seen = Array.isArray(raw.seen) ? raw.seen : [];
      state.firstRun = typeof raw.firstRun === 'boolean' ? raw.firstRun : true;
    }
  } catch {
    state = { seen: [], firstRun: true };
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url).trim().replace(/\/$/, '');
  }
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isBadLink(href) {
  const h = String(href || '').toLowerCase();
  return (
    !h ||
    h === 'https://www.inberlinwohnen.de' ||
    h === 'https://www.inberlinwohnen.de/' ||
    h.includes('/datenschutz') ||
    h.includes('/impressum') ||
    h.includes('/login') ||
    h.includes('/kontakt') ||
    h.includes('/wohnungsfinder') ||
    h.includes('/wohnungstausch') ||
    h.includes('/wohnungsvergabe') ||
    h.includes('/mein-bereich') ||
    h.endsWith('#') ||
    h.includes('mailto:') ||
    h.includes('javascript:')
  );
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

async function login(page) {
  await page.goto('https://www.inberlinwohnen.de/login/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.locator('button:has-text("Alle akzeptieren")').click().catch(() => {});

  const email = page.locator('input[name="email"]');
  if (await email.count()) {
    await email.fill(INBERLIN_EMAIL);
    await page.locator('input[name="password"]').fill(INBERLIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(6000);
  }
}

async function openFinder(page) {
  await page.goto(PERSONAL_WOHNUNGSFINDER_URL, {
    waitUntil: 'networkidle',
    timeout: 120000
  });
  await page.waitForTimeout(6000);
}

async function dumpDebug(page) {
  ensureDirs();
  const html = await page.content();
  fs.writeFileSync(path.join(DEBUG_DIR, 'last.html'), html);
  await page.screenshot({ path: path.join(DEBUG_DIR, 'last.png'), fullPage: true }).catch(() => {});
  const signals = await page.evaluate(() => {
    const arr = Array.from(document.querySelectorAll('body *'))
      .map(el => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 25)
      .filter(t => /zimmer|qm|m²|€|euro|kaltmiete|warmmiete|bezirk|wohnung|angebot|expose/i.test(t))
      .slice(0, 100);
    return arr;
  });
  fs.writeFileSync(path.join(DEBUG_DIR, 'signals.json'), JSON.stringify(signals, null, 2));
}

async function extractListings(page) {
  return await page.evaluate((badLinkFnStr) => {
    const isBadLink = new Function(`return (${badLinkFnStr})`)();

    const textScore = (t) => {
      let score = 0;
      if (/€|euro|kaltmiete|warmmiete/i.test(t)) score += 3;
      if (/zimmer|qm|m²/i.test(t)) score += 3;
      if (/bezirk|berlin/i.test(t)) score += 1;
      if (/wohnung|angebot|expose/i.test(t)) score += 2;
      return score;
    };

    const candidates = [];
    const selectors = [
      'article',
      'li',
      '.card',
      '.result',
      '.listing',
      '.listing-item',
      '.offer',
      '.angebot',
      'div'
    ];

    for (const sel of selectors) {
      candidates.push(...Array.from(document.querySelectorAll(sel)));
    }

    const out = [];
    const seen = new Set();

    for (const node of candidates) {
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 30) continue;

      const score = textScore(text);
      if (score < 5) continue;

      const links = Array.from(node.querySelectorAll('a[href]'));
      const good = links.find(a => {
        const href = (a.href || '').trim();
        if (isBadLink(href)) return false;
        if (!href.includes('inberlinwohnen.de')) return false;
        return true;
      });

      if (!good) continue;

      const href = good.href.replace(/\/$/, '').split('?')[0];
      if (seen.has(href)) continue;
      seen.add(href);

      out.push({
        href,
        text: text.slice(0, 600)
      });
    }

    const simpleAnchors = Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({
        href: (a.href || '').trim(),
        text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim()
      }))
      .filter(x => !isBadLink(x.href))
      .filter(x => x.href.includes('inberlinwohnen.de'))
      .filter(x => /€|euro|kaltmiete|warmmiete|zimmer|qm|m²|wohnung|angebot|expose/i.test(x.text));

    for (const a of simpleAnchors) {
      const href = a.href.replace(/\/$/, '').split('?')[0];
      if (seen.has(href)) continue;
      seen.add(href);
      out.push({
        href,
        text: a.text.slice(0, 600)
      });
    }

    return out;
  }, isBadLink.toString());
}

function formatListing(item) {
  const title = (item.text.split('\n')[0] || item.href).slice(0, 140);
  return `• <b>${escapeHtml(title)}</b>\n${escapeHtml(item.text)}\n${escapeHtml(item.href)}`;
}

async function checkApartments() {
  ensureDirs();

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
    await login(page);
    await openFinder(page);
    await dumpDebug(page);

    const listings = await extractListings(page);
    const current = listings.map(x => normalizeUrl(x.href));
    const previous = new Set(state.seen);

    if (state.firstRun) {
      state.seen = current;
      state.firstRun = false;
      saveState();

      const msg =
        `<b>Бот запущен</b>\n` +
        `Найдено квартир: ${listings.length}` +
        (listings.length
          ? `\n\n${listings.slice(0, 10).map(formatListing).join('\n\n')}`
          : `\n\nНе нашёл карточки квартир. Сохранился HTML и скрин в /tmp/inberlin_debug`);

      await sendTelegram(msg, listings[0]?.href || PERSONAL_WOHNUNGSFINDER_URL);
      return;
    }

    const added = listings.filter(x => !previous.has(normalizeUrl(x.href)));
    const removed = [...previous].filter(x => !current.includes(x));

    if (added.length === 0 && removed.length === 0) {
      console.log('Изменений нет');
      return;
    }

    const parts = [];

    if (added.length) {
      parts.push(
        `<b>Добавили квартир: ${added.length}</b>\n\n` +
        added.map(formatListing).join('\n\n')
      );
    }

    if (removed.length) {
      parts.push(
        `<b>Убрали квартир: ${removed.length}</b>\n\n` +
        removed.map(h => `• ${escapeHtml(h)}`).join('\n')
      );
    }

    const buttonUrl = added[0]?.href || listings[0]?.href || PERSONAL_WOHNUNGSFINDER_URL;
    for (const msg of parts) {
      await sendTelegram(msg, buttonUrl);
    }

    state.seen = current;
    saveState();
  } catch (e) {
    console.error(e);
    await sendTelegram(`Ошибка: ${escapeHtml(e.message)}`).catch(() => {});
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  loadState();

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !INBERLIN_EMAIL || !INBERLIN_PASSWORD) {
    throw new Error('Не заданы TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, INBERLIN_EMAIL, INBERLIN_PASSWORD');
  }

  await checkApartments();
  setInterval(() => {
    checkApartments().catch(err => console.error(err));
  }, CHECK_INTERVAL);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
