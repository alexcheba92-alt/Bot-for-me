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

let state = { seen: [], firstRun: true };

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
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });
  await page.waitForTimeout(8000);
}

function isInterestingJson(obj) {
  const s = JSON.stringify(obj).toLowerCase();
  return /wohnung|kaltmiete|warmmiete|zimmer|qm|m²|berlin|expose|angebot/.test(s);
}

function extractFromJson(value) {
  const out = [];

  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (typeof node !== 'object') return;

    const keys = Object.keys(node).map(k => k.toLowerCase());
    const text = JSON.stringify(node).toLowerCase();

    if (isInterestingJson(node)) {
      let href = null;
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'string' && v.includes('inberlinwohnen.de') && !v.includes('datenschutz') && !v.includes('impressum')) {
          href = v;
          break;
        }
      }

      const title =
        node.title ||
        node.name ||
        node.label ||
        node.caption ||
        node.heading ||
        node.objekt ||
        node.address ||
        node.wohnungsname ||
        '';

      const price =
        node.price ||
        node.miete ||
        node.kaltmiete ||
        node.warmmiete ||
        '';

      const rooms =
        node.rooms ||
        node.zimmer ||
        node.roomCount ||
        '';

      const area =
        node.area ||
        node.qm ||
        node.size ||
        node.flaeche ||
        '';

      const district =
        node.district ||
        node.bezirk ||
        node.region ||
        node.ort ||
        '';

      const summary = [title, price, rooms, area, district].filter(Boolean).join(' | ').trim();

      if (href && summary) {
        out.push({
          href: normalizeUrl(href),
          text: summary.slice(0, 500)
        });
      }
    }

    for (const v of Object.values(node)) walk(v);
  };

  walk(value);

  const uniq = [];
  const seen = new Set();
  for (const x of out) {
    if (!x.href || seen.has(x.href)) continue;
    seen.add(x.href);
    uniq.push(x);
  }
  return uniq;
}

async function collectNetworkData(page) {
  const responses = [];
  page.on('response', async (res) => {
    try {
      const url = res.url();
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json') && !ct.includes('javascript') && !ct.includes('text') && !ct.includes('html')) return;
      if (!url.includes('inberlinwohnen.de')) return;

      const body = await res.text();
      responses.push({
        url,
        status: res.status(),
        contentType: ct,
        body: body.slice(0, 50000)
      });
    } catch {}
  });
  return responses;
}

async function dumpDebug(page, responses) {
  ensureDirs();
  fs.writeFileSync(path.join(DEBUG_DIR, 'last.html'), await page.content());
  await page.screenshot({ path: path.join(DEBUG_DIR, 'last.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(DEBUG_DIR, 'responses.json'), JSON.stringify(responses, null, 2));
}

function formatListing(item) {
  const title = (item.text || item.href).slice(0, 140);
  return `• <b>${escapeHtml(title)}</b>\n${escapeHtml(item.text || '')}\n${escapeHtml(item.href)}`;
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
  const responses = [];
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!url.includes('inberlinwohnen.de')) return;
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json') && !ct.includes('text') && !ct.includes('html') && !ct.includes('javascript')) return;
      const body = await res.text();
      responses.push({
        url,
        status: res.status(),
        contentType: ct,
        body: body.slice(0, 50000)
      });
    } catch {}
  });

  try {
    await login(page);
    await openFinder(page);
    await page.waitForTimeout(5000);

    const html = await page.content();
    fs.writeFileSync(path.join(DEBUG_DIR, 'last.html'), html);
    await page.screenshot({ path: path.join(DEBUG_DIR, 'last.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(DEBUG_DIR, 'responses.json'), JSON.stringify(responses, null, 2));

    let listings = [];

    for (const r of responses) {
      const body = r.body || '';
      if (body.startsWith('{') || body.startsWith('[')) {
        try {
          const json = JSON.parse(body);
          const found = extractFromJson(json);
          if (found.length) listings.push(...found);
        } catch {}
      }
    }

    listings = listings.filter(x => x.href && x.text);
    const uniq = [];
    const seen = new Set();
    for (const x of listings) {
      if (seen.has(x.href)) continue;
      seen.add(x.href);
      uniq.push(x);
    }
    listings = uniq;

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
          : `\n\nНе нашёл карточки квартир. Сохранился HTML, скрин и network в /tmp/inberlin_debug`);

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
    await dumpDebug(page, responses).catch(() => {});
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
