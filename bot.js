'use strict';

require('dotenv').config();
const { chromium } = require('playwright');
const axios    = require('axios');
const FormData = require('form-data');
const fs       = require('fs');
const path     = require('path');

// ================================================================
//  КОНФИГ
// ================================================================
const C = {
  email:      process.env.INBERLIN_EMAIL    || '',
  password:   process.env.INBERLIN_PASSWORD || '',
  tgToken:    process.env.TELEGRAM_TOKEN    || '',
  tgChatId:   process.env.TELEGRAM_CHAT_ID  || '',

  maxRent:   600,
  minRooms:  3,

  intervalMs: 5 * 60 * 1000,

  loginUrl:   'https://www.inberlinwohnen.de/login',
  finderUrl:  'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder',
  baseUrl:    'https://www.inberlinwohnen.de',
  outDir:     path.join(__dirname, 'out'),
};

if (!fs.existsSync(C.outDir)) fs.mkdirSync(C.outDir, { recursive: true });

// ================================================================
//  КОНФИГ ПРОВЕРКА
// ================================================================
function checkConfig() {
  const missing = [];
  if (!C.email)    missing.push('INBERLIN_EMAIL');
  if (!C.password) missing.push('INBERLIN_PASSWORD');
  if (!C.tgToken)  missing.push('TELEGRAM_TOKEN');
  if (!C.tgChatId) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) {
    console.error('❌ Не заполнены переменные:', missing.join(', '));
    process.exit(1);
  }
}

// ================================================================
//  ЛОГ
// ================================================================
const logFile = path.join(C.outDir, 'bot.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch (_) {}
}

// ================================================================
//  СОСТОЯНИЕ
// ================================================================
const stateFile = path.join(C.outDir, 'state.json');
function loadState() {
  try { if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
  return { known: {}, lastCount: null, firstRun: true };
}
function saveState(s) { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); }
let STATE = loadState();

// ================================================================
//  TELEGRAM
// ================================================================
const TG = `https://api.telegram.org/bot${C.tgToken}`;

async function tgText(text, extra = {}) {
  try {
    await axios.post(`${TG}/sendMessage`, {
      chat_id: C.tgChatId, text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    }, { timeout: 15000 });
  } catch (e) { log('TG error:', e.message); }
}

async function tgPhoto(filePath, caption = '') {
  try {
    const form = new FormData();
    form.append('chat_id',    C.tgChatId);
    form.append('photo',      fs.createReadStream(filePath));
    form.append('caption',    caption.slice(0, 1024));
    form.append('parse_mode', 'HTML');
    await axios.post(`${TG}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 30000 });
  } catch (e) { log('TG photo error:', e.message); }
}

function ibwBtn(url) {
  return { inline_keyboard: [[{ text: '🔗 Открыть на inberlinwohnen.de', url }]] };
}

// ================================================================
//  СООБЩЕНИЯ
// ================================================================
function msgNew(apt) {
  const lines = [
    '🏠 <b>Новая квартира!</b>',
    '',
    apt.title    ? `<b>${apt.title}</b>`                 : null,
    apt.address  ? `📍 ${apt.address}`                   : null,
    apt.district ? `🗺 Район: ${apt.district}`           : null,
    apt.rooms    ? `🛏 Комнат: <b>${apt.rooms}</b>`      : null,
    apt.size     ? `📐 Площадь: <b>${apt.size} м²</b>`  : null,
    apt.rent     ? `💶 Kaltmiete: <b>${apt.rent} €</b>` : null,
    apt.company  ? `🏢 ${apt.company}`                   : null,
    apt.wbs      ? `🔑 ${apt.wbs}`                      : null,
  ].filter(Boolean).join('\n');
  return { text: lines, markup: ibwBtn(apt.url) };
}

function msgGone(apt) {
  return [
    '❌ <b>Квартира снята с публикации</b>',
    '',
    apt.title   ? apt.title              : null,
    apt.address ? `📍 ${apt.address}`    : null,
    apt.rooms   ? `🛏 ${apt.rooms} комн.` : null,
    apt.size    ? `📐 ${apt.size} м²`   : null,
    apt.rent    ? `💶 ${apt.rent} €`    : null,
    `🔗 ${apt.url}`,
  ].filter(Boolean).join('\n');
}

// ================================================================
//  SAFE GOTO — защита от Download/редиректов
// ================================================================
async function safeGoto(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    return resp;
  } catch (e) {
    log('GOTO ERROR:', url, e.message);
    return null;
  }
}

// ================================================================
//  БРАУЗЕР — создаём один раз, держим сессию
// ================================================================
let browser  = null;
let ctx      = null;
let page     = null;
let loggedIn = false;

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    log('Запускаю браузер...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    ctx = null; page = null; loggedIn = false;
  }
  if (!ctx) {
    ctx = await browser.newContext({
      locale: 'de-DE', timezoneId: 'Europe/Berlin',
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    loggedIn = false;
  }
}

async function resetSession() {
  log('Сбрасываю сессию...');
  try { if (ctx) await ctx.close(); } catch (_) {}
  ctx = null; page = null; loggedIn = false;
}

// ================================================================
//  АВТОРИЗАЦИЯ — один раз, потом держим сессию
// ================================================================
async function doLogin() {
  log('Авторизация...');

  const resp = await safeGoto(page, C.loginUrl);
  if (!resp) throw new Error('Страница логина недоступна');

  await page.waitForTimeout(2000);

  // Cookie попап
  for (const s of ['text="Alle akzeptieren"', 'text="Speichern"', 'text="Akzeptieren"']) {
    try {
      const btn = page.locator(s).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        log('Cookie попап закрыт');
        await page.waitForTimeout(1000);
        break;
      }
    } catch (_) {}
  }

  await page.locator('input[type="email"]').first().waitFor({ state: 'visible', timeout: 15000 });

  // pressSequentially — обходит Livewire защиту
  await page.locator('input[type="email"]').first().click();
  await page.locator('input[type="email"]').first().pressSequentially(C.email, { delay: 80 });
  log('Email введён');

  await page.locator('input[type="password"]').first().click();
  await page.locator('input[type="password"]').first().pressSequentially(C.password, { delay: 80 });
  log('Пароль введён');

  await page.locator('button[type="submit"]').first().click();
  log('Log in нажат');

  await page.waitForTimeout(5000);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

  const url = page.url();
  log('URL после логина:', url);

  if (url.includes('/login')) {
    const body = await page.locator('body').innerText().catch(() => '');
    if (body.includes('überprüfen') || body.includes('ungültig') || body.includes('falsch')) {
      throw new Error('Неверный email или пароль');
    }
    try {
      await page.waitForURL(u => !u.includes('/login'), { timeout: 10000 });
    } catch (_) {
      log('Livewire — нет редиректа, считаем залогиненным');
    }
  }

  log('✅ Авторизован:', page.url());
  loggedIn = true;
}

async function ensureLoggedIn() {
  if (loggedIn) {
    // Проверяем что сессия жива — пробуем зайти на finder
    const resp = await safeGoto(page, C.finderUrl);
    if (!resp) { loggedIn = false; }
    else {
      const url = page.url();
      if (url.includes('/login')) {
        log('Сессия истекла, перелогиниваюсь...');
        loggedIn = false;
      }
    }
  }
  if (!loggedIn) {
    await doLogin();
    // После логина сразу переходим на finder
    await safeGoto(page, C.finderUrl);
    await page.waitForTimeout(2000);
  }
}

// ================================================================
//  ПАРСИНГ — все страницы
// ================================================================
async function scrapeAll() {
  log('Парсю квартиры...');

  const all = [];
  let pageNum = 1;

  while (true) {
    log(`Страница ${pageNum}...`);
    const items = await parseCurrentPage();
    log(`Страница ${pageNum}: ${items.length} квартир`);
    all.push(...items);

    // Ищем кнопку следующей страницы
    const hasNext = await goToNextPage(page, pageNum);
    if (!hasNext) {
      log(`Пагинация закончилась. Всего: ${all.length}`);
      break;
    }
    pageNum++;
    if (pageNum > 10) break;
  }

  return dedupe(all);
}

async function goToNextPage(page, currentPageNum) {
  const nextNum = currentPageNum + 1;

  // Логируем все ссылки пагинации для диагностики
  const allLinks = await page.locator('a').all();
  const linkInfo = [];
  for (const l of allLinks) {
    try {
      const t    = (await l.innerText()).trim();
      const href = (await l.getAttribute('href') || '').trim();
      if (t && t.length < 30) linkInfo.push(`"${t}"→${href.slice(0,40)}`);
    } catch (_) {}
  }
  log('Все ссылки на странице:', linkInfo.join(' | ').slice(0, 300));

  // Пробуем разные варианты кнопки следующей страницы
  const candidates = [
    // По тексту
    page.locator('a').filter({ hasText: /^Vor$/ }).first(),
    page.locator('a').filter({ hasText: /^Vor >$/ }).first(),
    page.locator('a').filter({ hasText: /^>$/ }).first(),
    page.locator('a').filter({ hasText: /^»$/ }).first(),
    page.locator('a').filter({ hasText: new RegExp('^' + nextNum + '$') }).first(),
    // По href
    page.locator(`a[href*="page=${nextNum}"]`).first(),
    page.locator(`a[href*="seite=${nextNum}"]`).first(),
    page.locator(`a[href*="p=${nextNum}"]`).first(),
    // По классу
    page.locator('li.next a, .pagination-next a, a.next').first(),
    page.locator('[class*="pagination"] a[rel="next"]').first(),
  ];

  for (const btn of candidates) {
    try {
      if (await btn.isVisible({ timeout: 800 })) {
        const t = (await btn.innerText()).trim();
        log(`Кнопка следующей страницы: "${t}"`);
        await btn.click();
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (_) {}
  }

  return false;
}

// ================================================================
//  ПАРСИНГ ОДНОЙ СТРАНИЦЫ
// ================================================================
async function parseCurrentPage() {
  const result = [];

  // Скриншот только на первой странице (для firstRun сообщения)
  const ssPath = path.join(C.outDir, 'results.png');
  if (!fs.existsSync(ssPath)) {
    await page.screenshot({ path: ssPath, fullPage: false });
  }

  // Ищем строки с квартирами
  // Формат: "3.0 Zimmer, 70,28 m², 466,94 € | Alfred-Randt-Straße 32, 12559 Treptow-Köpenick"
  const rows = await page.locator('li, tr, [class*="result"], [class*="item"], [class*="expose"]').all();

  for (const row of rows) {
    try {
      const text = (await row.innerText().catch(() => '')).trim();
      if (!text.includes('Zimmer') || !text.includes('€')) continue;
      if (text.length < 15) continue;

      const apt = parseAptText(text);
      if (!apt) continue;

      // Ищем ссылку
      apt.url = await findLink(row) || C.finderUrl;
      apt.id  = apt.url !== C.finderUrl ? apt.url
              : `apt_${apt.rooms}_${apt.rent}_${apt.size}_${apt.address.slice(0,20)}`;

      if (passesFilter(apt)) result.push(apt);
    } catch (_) {}
  }

  // Если ничего не нашли — пробуем через все ссылки на странице
  if (result.length === 0) {
    log('Rows пустые, парсю через ссылки...');
    return parseViaLinks();
  }

  return result;
}

// ================================================================
//  ПАРСИНГ ТЕКСТА КАРТОЧКИ
//  Формат: "3.0 Zimmer, 70,28 m², 466,94 € | Straße 32, 12559 Berlin"
// ================================================================
function parseAptText(text) {
  // Комнаты: "3.0 Zimmer", "2 1/2-Zimmer", "3 Zimmer"
  const roomsMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:1\/2-)?Zimmer/i);
  const rooms = roomsMatch ? toFloat(roomsMatch[1]) : null;

  // Площадь: "70,28 m²"
  const sizeMatch = text.match(/(\d+(?:[,.]?\d+)?)\s*m²/i);
  const size = sizeMatch ? toFloat(sizeMatch[1]) : null;

  // Аренда: "466,94 €" — от 100 до 9999
  const rentMatch = text.match(/\b(\d{3,4}(?:[,.]\d{1,2})?)\s*€/);
  const rent = rentMatch ? toFloat(rentMatch[1]) : null;

  // Адрес — после символа "|"
  let address = '';
  let district = '';
  const pipeIdx = text.indexOf('|');
  if (pipeIdx !== -1) {
    // Берём первую строку после |
    const raw = text.slice(pipeIdx + 1).trim().split('\n')[0].trim();
    address = raw;
    // PLZ паттерн: "12559 Treptow-Köpenick" → район = "Treptow-Köpenick"
    const plzMatch = raw.match(/\d{5}\s+(.+)/);
    if (plzMatch) district = plzMatch[1].trim();
  } else {
    address  = extractAddress(text);
    district = extractDistrict(text);
  }

  if (!rooms && !rent) return null;

  return {
    id: '', url: C.finderUrl,
    title: '',
    address,
    district: district || extractDistrict(text),
    company:  extractCompany(text),
    rent:     rent  != null ? rent.toFixed(2)  : '',
    rooms:    rooms != null ? String(rooms)    : '',
    size:     size  != null ? String(size)     : '',
    wbs:      /\bWBS\b/i.test(text) ? 'Требуется WBS' : '',
  };
}

async function findLink(el) {
  try {
    const links = await el.locator('a[href]').all();
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      if (href.match(/\d{4,}/) || /expose|objekt|wohnung|apartment/i.test(href)) {
        return href.startsWith('http') ? href : C.baseUrl + href;
      }
    }
    // Любая непустая ссылка
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (href && href !== '#' && !href.startsWith('mailto') && !href.startsWith('tel')) {
        return href.startsWith('http') ? href : C.baseUrl + href;
      }
    }
  } catch (_) {}
  return null;
}

async function parseViaLinks() {
  const result = [];
  const links = await page.locator('a[href]').all();

  for (const link of links) {
    try {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#' || href.startsWith('mailto') || href.startsWith('tel')) continue;

      const fullUrl = href.startsWith('http') ? href : C.baseUrl + href;
      if (result.find(a => a.id === fullUrl)) continue;

      const parentText = await link.evaluate(el => {
        let node = el;
        for (let i = 0; i < 5; i++) {
          node = node.parentElement;
          if (!node) break;
          const t = (node.innerText || '').trim();
          if ((t.includes('Zimmer') || t.includes('m²')) && t.length > 20) return t;
        }
        return (el.innerText || '').trim();
      }).catch(() => '');

      if (!parentText.includes('Zimmer') && !parentText.includes('€')) continue;

      const apt = parseAptText(parentText);
      if (!apt) continue;
      apt.id  = fullUrl;
      apt.url = fullUrl;

      if (passesFilter(apt)) result.push(apt);
    } catch (_) {}
  }

  return result;
}

// ================================================================
//  ВСПОМОГАЛЬНЫЕ ФУНКЦИИ
// ================================================================
function toFloat(v) {
  if (!v && v !== 0) return 0;
  return parseFloat(String(v).replace(/\s/g, '').replace(',', '.')) || 0;
}

function extractAddress(text) {
  const m = text.match(/([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\s\-.]*(?:straße|str\.|allee|weg|platz|damm|ring|chaussee|gasse|ufer)\s*\d*)/i);
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}

function extractDistrict(text) {
  const list = [
    'Mitte','Tiergarten','Wedding','Prenzlauer Berg','Friedrichshain','Kreuzberg',
    'Pankow','Weißensee','Charlottenburg','Wilmersdorf','Spandau','Steglitz',
    'Zehlendorf','Tempelhof','Schöneberg','Neukölln','Treptow','Köpenick',
    'Treptow-Köpenick','Marzahn','Hellersdorf','Marzahn-Hellersdorf',
    'Lichtenberg','Hohenschönhausen','Reinickendorf','Wittenau','Tegel',
    'Buch','Adlershof','Heinersdorf',
  ];
  for (const d of list) { if (text.includes(d)) return d; }
  return '';
}

function extractCompany(text) {
  const list = ['degewo','GESOBAU','Gewobag','HOWOGE','STADT UND LAND','WBM','berlinovo'];
  for (const c of list) { if (text.toLowerCase().includes(c.toLowerCase())) return c; }
  return '';
}

function passesFilter(apt) {
  const rent  = toFloat(apt.rent);
  const rooms = toFloat(apt.rooms);
  if (rent  > 0 && rent  > C.maxRent)  return false;
  if (rooms > 0 && rooms < C.minRooms) return false;
  return true;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(a => {
    const key = a.id || `${a.rent}_${a.rooms}_${a.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ================================================================
//  ГЛАВНЫЙ ЦИКЛ — while(true) вместо setInterval
// ================================================================
let errCount = 0;

async function runCheck() {
  try {
    await ensureBrowser();
    await ensureLoggedIn();

    // Скриншот сбрасываем перед каждой проверкой
    const ssPath = path.join(C.outDir, 'results.png');
    if (fs.existsSync(ssPath)) fs.unlinkSync(ssPath);

    const apartments = await scrapeAll();

    // Дебаг первых 3
    apartments.slice(0, 3).forEach((a, i) =>
      log(`[${i}] rooms=${a.rooms} rent=${a.rent}€ size=${a.size}m² | ${a.address} | ${a.url.slice(0, 60)}`)
    );

    const prevKnown = STATE.known || {};
    const currMap   = {};
    for (const a of apartments) currMap[a.id] = a;

    const added   = apartments.filter(a => !prevKnown[a.id]);
    const removed = Object.values(prevKnown).filter(a => !currMap[a.id]);

    log(`Итого: ${apartments.length} | Новых: ${added.length} | Ушло: ${removed.length}`);

    // Первый запуск
    if (STATE.firstRun) {
      STATE.firstRun = false;
      await tgText(
        `🤖 <b>Бот запущен!</b>\n\n` +
        `🔍 Мониторю inberlinwohnen.de\n` +
        `💶 Kaltmiete до ${C.maxRent} €\n` +
        `🛏 Комнат от ${C.minRooms}\n` +
        `⏱ Каждые ${C.intervalMs / 60000} мин\n\n` +
        `📊 Сейчас по фильтру: <b>${apartments.length} квартир</b>`
      );
      const ssPath2 = path.join(C.outDir, 'results.png');
      if (fs.existsSync(ssPath2)) await tgPhoto(ssPath2, `Страница поиска (${apartments.length} квартир)`);
    }

    for (const apt of added) {
      log('НОВАЯ:', apt.id);
      const { text, markup } = msgNew(apt);
      await tgText(text, { reply_markup: markup });
      await sleep(700);
    }

    for (const apt of removed) {
      log('УШЛА:', apt.id);
      await tgText(msgGone(apt));
      await sleep(700);
    }

    if (!STATE.firstRun && STATE.lastCount !== null &&
        STATE.lastCount !== apartments.length &&
        added.length === 0 && removed.length === 0) {
      await tgText(`📊 Квартир: <b>${STATE.lastCount} → ${apartments.length}</b>`);
    }

    STATE.known     = currMap;
    STATE.lastCount = apartments.length;
    saveState(STATE);
    errCount = 0;

  } catch (e) {
    errCount++;
    log('ОШИБКА:', e.message);
    await tgText(`⚠️ Ошибка #${errCount}:\n<code>${e.message}</code>`).catch(() => {});

    // Сбрасываем сессию при ошибках
    await resetSession();

    // При многих ошибках подряд — пересоздаём браузер
    if (errCount % 3 === 0) {
      try { if (browser) await browser.close(); } catch (_) {}
      browser = null;
    }
  }
}

// ================================================================
//  СТАРТ — while(true) без setInterval
// ================================================================
async function main() {
  checkConfig();
  log('=== Бот inberlinwohnen.de ===');

  while (true) {
    await runCheck();
    log(`Жду ${C.intervalMs / 60000} мин до следующей проверки...`);
    await sleep(C.intervalMs);
  }
}

process.on('SIGINT',  async () => { log('SIGINT'); try { await browser?.close(); } catch (_) {} process.exit(0); });
process.on('SIGTERM', async () => { log('SIGTERM'); try { await browser?.close(); } catch (_) {} process.exit(0); });
process.on('uncaughtException', async (e) => {
  log('UNCAUGHT:', e.stack);
  try { await tgText(`💥 Критическая ошибка:\n<code>${e.message}</code>`); } catch (_) {}
});

main().catch(async e => {
  log('FATAL:', e.stack);
  try { await tgText(`💥 Не запустился:\n${e.message}`); } catch (_) {}
  process.exit(1);
});
