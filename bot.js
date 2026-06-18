'use strict';

/**
 * ================================================================
 *  inberlinwohnen.de — Бот мониторинга квартир
 * ================================================================
 *  Railway Variables:
 *    INBERLIN_EMAIL, INBERLIN_PASSWORD
 *    TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
 * ================================================================
 */

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

  loginUrl:  'https://www.inberlinwohnen.de/login',
  finderUrl: 'https://www.inberlinwohnen.de/wohnungsfinder',
  baseUrl:   'https://www.inberlinwohnen.de',
  outDir:    path.join(__dirname, 'out'),
};

if (!fs.existsSync(C.outDir)) fs.mkdirSync(C.outDir, { recursive: true });

// ================================================================
//  ПРОВЕРКА КОНФИГА
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
  try {
    if (fs.existsSync(stateFile))
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {}
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
      chat_id: C.tgChatId,
      text,
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
    await axios.post(`${TG}/sendPhoto`, form, {
      headers: form.getHeaders(), timeout: 30000,
    });
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
    apt.title   ? apt.title                   : null,
    apt.address ? `📍 ${apt.address}`         : null,
    apt.rooms   ? `🛏 ${apt.rooms} комн.`    : null,
    apt.size    ? `📐 ${apt.size} м²`        : null,
    apt.rent    ? `💶 ${apt.rent} €`         : null,
    `🔗 ${apt.url}`,
  ].filter(Boolean).join('\n');
}

// ================================================================
//  АВТОРИЗАЦИЯ
// ================================================================
async function doLogin(page) {
  log('Авторизация...');

  await page.goto(C.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);

  // Cookie попап
  for (const s of [
    'text="Alle akzeptieren"', 'text="Speichern"', 'text="Akzeptieren"'
  ]) {
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

  // Ждём форму
  await page.locator('input[type="email"]').first().waitFor({ state: 'visible', timeout: 15000 });

  // Вводим через pressSequentially — обходит Livewire защиту
  await page.locator('input[type="email"]').first().click();
  await page.locator('input[type="email"]').first().pressSequentially(C.email, { delay: 80 });
  log('Email введён');

  await page.locator('input[type="password"]').first().click();
  await page.locator('input[type="password"]').first().pressSequentially(C.password, { delay: 80 });
  log('Пароль введён');

  // Нажимаем сразу
  await page.locator('button[type="submit"]').first().click();
  log('Log in нажат');

  // Ждём редиректа
  await page.waitForTimeout(5000);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

  const url = page.url();
  log('URL после логина:', url);

  if (url.includes('/login')) {
    const body = await page.locator('body').innerText().catch(() => '');
    log('Ответ сайта:', body.slice(0, 200));
    // Пробуем ещё раз подождать редирект
    try {
      await page.waitForURL(u => !u.includes('/login'), { timeout: 10000 });
      log('✅ Авторизован (поздний редирект):', page.url());
    } catch (_) {
      if (!body.includes('überprüfen') && !body.includes('ungültig') && !body.includes('falsch')) {
        log('✅ Авторизован (Livewire, без редиректа)');
        return;
      }
      throw new Error('Сайт отклонил логин — überprüfen. Email: ' + C.email.slice(0,5) + '...');
    }
  } else {
    log('✅ Авторизован:', url);
  }
}

// ================================================================
//  ПАРСИНГ КВАРТИР
// ================================================================
async function scrape(page) {
  log('Загружаю wohnungsfinder...');

  await page.goto(C.finderUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);

  // Закрыть cookie попап если появился
  for (const s of ['text="Alle akzeptieren"', 'text="Speichern"']) {
    try {
      const b = page.locator(s).first();
      if (await b.isVisible({ timeout: 1500 })) { await b.click(); await page.waitForTimeout(800); }
    } catch (_) {}
  }

  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Скриншот первой страницы
  const ssPath = path.join(C.outDir, 'results.png');
  await page.screenshot({ path: ssPath, fullPage: false });

  // Парсим все страницы
  const all = [];
  let pageNum = 1;

  while (true) {
    log('Парсю страницу ' + pageNum + '...');
    const items = await parsePage(page);
    log('Страница ' + pageNum + ': ' + items.length + ' квартир');
    all.push(...items);

    // Ищем кнопку "Vor >" / "Weiter" / "Nächste"
    const nextBtn = page.locator('a:has-text("Vor"), a:has-text("Weiter"), a:has-text("»"), li.next a, .pagination a[rel="next"]').first();
    let hasNext = false;
    try { hasNext = await nextBtn.isVisible({ timeout: 2000 }); } catch (_) {}

    if (!hasNext) {
      log('Больше страниц нет, итого: ' + all.length);
      break;
    }

    await nextBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    pageNum++;

    // Защита от бесконечного цикла
    if (pageNum > 10) break;
  }

  return { apartments: dedupe(all), ssPath };
}

// Парсим одну страницу результатов
// Формат карточек на сайте:
// "3.0 Zimmer, 70,28 m², 466,94 € | Alfred-Randt-Straße 32, 12559 Treptow-Köpenick"
async function parsePage(page) {
  const result = [];

  // Сначала пробуем получить структурированные данные из Livewire snapshot в HTML
  const html = await page.content();
  fs.writeFileSync(path.join(C.outDir, 'finder.html'), html);

  const fromLivewire = extractFromLivewire(html);
  if (fromLivewire.length > 0) {
    log('Livewire данные: ' + fromLivewire.length + ' квартир');
    return fromLivewire;
  }

  // Fallback: парсим DOM карточки
  // На сайте карточки выглядят как строки с паттерном "X.0 Zimmer, Y m², Z €"
  const rows = await page.locator('li, tr, [class*="result"], [class*="item"], [class*="row"]').all();

  for (const row of rows) {
    try {
      const text = await row.innerText().catch(() => '');
      // Проверяем что это карточка квартиры — должны быть Zimmer и €
      if (!text.includes('Zimmer') || !text.includes('€')) continue;
      // Минимальная длина
      if (text.trim().length < 20) continue;

      const apt = parseCardText(text, row, page);
      if (!apt) continue;

      // Ищем ссылку
      apt.url = await findUrl(row) || C.finderUrl;
      apt.id  = apt.url !== C.finderUrl ? apt.url : 'apt_' + apt.rent + '_' + apt.rooms + '_' + apt.size;

      if (passesFilter(apt)) result.push(apt);
    } catch (_) {}
  }

  // Если DOM не дал — парсим по тексту строк
  if (result.length === 0) {
    log('DOM пустой, парсю по тексту страницы...');
    return parseByText(html, page);
  }

  return result;
}

// Парсим текст карточки — формат сайта известен из скриншота
// "3.0 Zimmer, 70,28 m², 466,94 € | Alfred-Randt-Straße 32, 12559 Treptow-Köpenick"
function parseCardText(text, el, page) {
  // Комнаты: "3.0 Zimmer" или "2 1/2-Zimmer"
  const roomsMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:1\/2-)?Zimmer/i)
                  || text.match(/(\d+(?:[.,]\d+)?)\s*Zi\./i);
  const rooms = roomsMatch ? toFloat(roomsMatch[1]) : null;

  // Площадь: "70,28 m²"
  const sizeMatch = text.match(/(\d+(?:[,.]?\d+)?)\s*m²/i);
  const size = sizeMatch ? toFloat(sizeMatch[1]) : null;

  // Аренда: "466,94 €" — берём первое число перед € от 100 до 9999
  const rentMatch = text.match(/(\d{3,4}(?:[,.]\d{1,2})?)\s*€/);
  const rent = rentMatch ? toFloat(rentMatch[1]) : null;

  // Адрес — всё что после "|"
  let address = '';
  let district = '';
  const pipeIdx = text.indexOf('|');
  if (pipeIdx !== -1) {
    const afterPipe = text.slice(pipeIdx + 1).trim().split('\n')[0].trim();
    // "Alfred-Randt-Straße 32, 12559 Treptow-Köpenick"
    address = afterPipe;
    // Район — последняя часть после PLZ
    const distMatch = afterPipe.match(/\d{5}\s+(.+)/);
    if (distMatch) district = distMatch[1].trim();
  } else {
    // Пробуем найти адрес по паттерну улицы
    address = extractAddress(text);
    district = extractDistrict(text);
  }

  if (!rooms && !rent) return null;

  return {
    id:       '',
    url:      C.finderUrl,
    title:    '',
    address,
    district,
    company:  extractCompany(text),
    rent:     rent  != null ? rent.toFixed(2)  : '',
    rooms:    rooms != null ? String(rooms)    : '',
    size:     size  != null ? String(size)     : '',
    wbs:      /\bWBS\b/i.test(text) ? 'Требуется WBS' : '',
  };
}

async function findUrl(el) {
  try {
    const links = await el.locator('a[href]').all();
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      if (href.match(/\d{4,}/) || href.includes('expose') || href.includes('objekt') || href.includes('wohnung')) {
        return href.startsWith('http') ? href : C.baseUrl + href;
      }
    }
    // Берём любую ссылку кроме якорей
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (href && href !== '#' && !href.startsWith('mailto') && !href.startsWith('tel')) {
        return href.startsWith('http') ? href : C.baseUrl + href;
      }
    }
  } catch (_) {}
  return null;
}

async function parseByText(html, page) {
  // Ищем все ссылки на странице у которых есть текст с Zimmer/€ в родителе
  const result = [];
  const links = await page.locator('a[href]').all();

  for (const link of links) {
    try {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;

      const fullUrl = href.startsWith('http') ? href : C.baseUrl + href;

      // Берём текст из родителя (до 4 уровней)
      const parentText = await link.evaluate(el => {
        let node = el;
        for (let i = 0; i < 4; i++) {
          node = node.parentElement;
          if (!node) break;
          const t = (node.innerText || '').trim();
          if ((t.includes('Zimmer') || t.includes('m²')) && t.length > 20) return t;
        }
        return (el.innerText || '').trim();
      }).catch(() => '');

      if (!parentText.includes('Zimmer') && !parentText.includes('€')) continue;
      if (result.find(a => a.id === fullUrl)) continue;

      const apt = parseCardText(parentText, null, page);
      if (!apt) continue;
      apt.id  = fullUrl;
      apt.url = fullUrl;

      if (passesFilter(apt)) result.push(apt);
    } catch (_) {}
  }

  return result;
}

// ================================================================
//  LIVEWIRE + API ИЗВЛЕЧЕНИЕ
// ================================================================
function extractFromLivewire(html) {
  const apartments = [];
  try {
    const patterns = [
      /wire:snapshot="([^"]+)"/g,
      /wire:initial-data="([^"]+)"/g,
    ];
    for (const rx of patterns) {
      let m;
      while ((m = rx.exec(html)) !== null) {
        try {
          const raw = m[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
          const data = JSON.parse(raw);
          const items = findApartmentArray(data);
          for (const item of items) {
            const apt = normalizeItem(item);
            if (apt && passesFilter(apt)) apartments.push(apt);
          }
        } catch (_) {}
      }
    }
    // JSON в script тегах
    const scriptRx = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let sm;
    while ((sm = scriptRx.exec(html)) !== null) {
      const jsonRx = /(\[{.+?}\])/gs;
      let jm;
      while ((jm = jsonRx.exec(sm[1])) !== null) {
        try {
          const arr = JSON.parse(jm[1]);
          if (Array.isArray(arr) && arr.length > 0 && hasAptFields(arr[0])) {
            for (const item of arr) {
              const apt = normalizeItem(item);
              if (apt && passesFilter(apt)) apartments.push(apt);
            }
          }
        } catch (_) {}
      }
    }
  } catch (e) { log('Livewire parse error:', e.message); }
  return dedupe(apartments);
}

function findApartmentArray(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj) && obj.length > 0 && hasAptFields(obj[0])) return obj;
  for (const key of Object.keys(obj)) {
    if (Array.isArray(obj[key]) && obj[key].length > 0 && hasAptFields(obj[key][0])) return obj[key];
    const found = findApartmentArray(obj[key], depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

function hasAptFields(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const keys = Object.keys(o).join(' ').toLowerCase();
  return keys.includes('rent') || keys.includes('miete') || keys.includes('zimmer') ||
         keys.includes('rooms') || keys.includes('wohnfl') || keys.includes('expose') ||
         keys.includes('kaltmiete') || keys.includes('flaeche');
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const rent  = toFloat(item.kaltmiete || item.kaltmiete_in_euro || item['kaltmiete-in-euro'] || item.rent || item.cold_rent || item.miete || item.price || 0);
  const rooms = toFloat(item.zimmer || item.zimmeranzahl || item['anzahl-zimmer'] || item.rooms || item.room_count || 0);
  const size  = toFloat(item.wohnflaeche || item['wohn-flaeche'] || item.flaeche || item.size || item.area || 0);
  let url = item.url || item.link || item.href || item.expose_url || item.detail_url || '';
  if (url && !url.startsWith('http')) url = C.baseUrl + (url.startsWith('/') ? '' : '/') + url;
  if (!url) { const id = item.id || item.expose_id || item.objekt_id; if (id) url = C.baseUrl + '/wohnungsfinder/?objekt=' + id; else url = C.finderUrl; }
  const id = String(item.id || item.expose_id || item.objekt_id || url);
  const address = [item.strasse || item.street || item.adresse || item.address || '', item.hausnummer || ''].filter(Boolean).join(' ').trim() || item.standort || '';
  return {
    id, url, title: item.titel || item.title || item.bezeichnung || '',
    address, district: item.bezirk || item.district || item.stadtteil || item.ortsteil || '',
    company: item.gesellschaft || item.company || item.anbieter || '',
    rent:  rent  > 0 ? rent.toFixed(2)  : '',
    rooms: rooms > 0 ? String(rooms)    : '',
    size:  size  > 0 ? String(size)     : '',
    wbs:   String(item.wbs || item.wbs_required || ''),
  };
}

// ================================================================
//  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ================================================================
function toFloat(v) {
  if (!v && v !== 0) return 0;
  return parseFloat(String(v).replace(/\s/g, '').replace(',', '.')) || 0;
}

function extractNum(text, rx) {
  const m = text.match(rx);
  return m ? toFloat(m[1]) : null;
}

function extractAddress(text) {
  const m = text.match(/([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\s\-.]*(?:straße|str\.|allee|weg|platz|damm|ring|chaussee|gasse|ufer)\s*\d*)/i);
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}

function extractDistrict(text) {
  const list = [
    'Mitte','Tiergarten','Wedding','Prenzlauer Berg','Friedrichshain','Kreuzberg',
    'Pankow','Weißensee','Heinersdorf','Charlottenburg','Wilmersdorf','Spandau',
    'Steglitz','Zehlendorf','Tempelhof','Schöneberg','Neukölln','Treptow',
    'Köpenick','Marzahn','Hellersdorf','Lichtenberg','Hohenschönhausen',
    'Reinickendorf','Wittenau','Tegel','Buch','Adlershof',
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
  return items.filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ================================================================
//  ГЛАВНЫЙ ЦИКЛ
// ================================================================
let browser  = null;
let errCount = 0;

async function runCheck() {
  let page = null;
  let ctx  = null;

  try {
    if (!browser || !browser.isConnected()) {
      log('Запускаю браузер...');
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    }

    ctx = await browser.newContext({
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(30000);

    await doLogin(page);
    const { apartments, ssPath } = await scrape(page);

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
      if (fs.existsSync(ssPath)) {
        await tgPhoto(ssPath, `Страница поиска (${apartments.length} квартир)`);
      }
    }

    // Новые квартиры
    for (const apt of added) {
      log('НОВАЯ:', apt.id);
      const { text, markup } = msgNew(apt);
      await tgText(text, { reply_markup: markup });
      await sleep(700);
    }

    // Ушедшие квартиры
    for (const apt of removed) {
      log('УШЛА:', apt.id);
      await tgText(msgGone(apt));
      await sleep(700);
    }

    // Изменилось количество без совпадений по ID
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
    if (errCount <= 3) {
      await tgText(`⚠️ Ошибка #${errCount}:\n<code>${e.message}</code>`).catch(() => {});
    }
    if (errCount % 3 === 0) {
      try { await browser?.close(); } catch (_) {}
      browser = null;
    }
  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { if (ctx)  await ctx.close();  } catch (_) {}
  }
}

// ================================================================
//  СТАРТ
// ================================================================
async function main() {
  checkConfig();
  log('=== Бот inberlinwohnen.de ===');
  await runCheck();
  setInterval(() => { log('--- Проверка ---'); runCheck(); }, C.intervalMs);
}

process.on('SIGINT',  async () => { try { await browser?.close(); } catch (_) {} process.exit(0); });
process.on('SIGTERM', async () => { try { await browser?.close(); } catch (_) {} process.exit(0); });
process.on('uncaughtException', async (e) => {
  log('UNCAUGHT:', e.stack);
  try { await tgText(`💥 Критическая ошибка:\n<code>${e.message}</code>`); } catch (_) {}
});

main().catch(async e => {
  log('FATAL:', e.stack);
  try { await tgText(`💥 Не запустился:\n${e.message}`); } catch (_) {}
  process.exit(1);
});
