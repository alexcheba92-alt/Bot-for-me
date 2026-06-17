'use strict';

/**
 * ================================================================
 *  inberlinwohnen.de — Бот мониторинга квартир
 * ================================================================
 *  ПОЧЕМУ Playwright, а НЕ axios+cheerio:
 *  Сайт — Laravel SPA. Квартиры грузятся JavaScript-ом ПОСЛЕ
 *  загрузки HTML. cheerio видит пустую страницу, потому что
 *  он не запускает JS. Playwright запускает реальный браузер.
 *
 *  УСТАНОВКА (один раз):
 *    npm install
 *    npx playwright install chromium
 *
 *  ЗАПУСК:
 *    node bot.js
 *
 *  НАСТРОЙКА — заполни .env файл (см. .env.example)
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
  email:      process.env.IBW_EMAIL    || '',
  password:   process.env.IBW_PASSWORD || '',
  tgToken:    process.env.TG_TOKEN     || '',
  tgChatId:   process.env.TG_CHAT_ID   || '',

  // Фильтры поиска
  maxRent:    600,   // Kaltmiete €
  minRooms:   2,     // минимум комнат

  intervalMs: 5 * 60 * 1000,  // 5 минут

  // URLs
  loginUrl:   'https://www.inberlinwohnen.de/login',
  finderUrl:  'https://www.inberlinwohnen.de/wohnungsfinder',
  baseUrl:    'https://www.inberlinwohnen.de',

  outDir: path.join(__dirname, 'out'),
};

// ================================================================
//  ИНИЦИАЛИЗАЦИЯ
// ================================================================
if (!fs.existsSync(C.outDir)) fs.mkdirSync(C.outDir, { recursive: true });

// Проверка конфига при старте
function checkConfig() {
  const missing = [];
  if (!C.email)    missing.push('IBW_EMAIL');
  if (!C.password) missing.push('IBW_PASSWORD');
  if (!C.tgToken)  missing.push('TG_TOKEN');
  if (!C.tgChatId) missing.push('TG_CHAT_ID');
  if (missing.length) {
    console.error('\n❌ Не заполнены переменные в .env файле:');
    missing.forEach(k => console.error(`   ${k}`));
    console.error('\nСкопируй .env.example в .env и заполни значения.\n');
    process.exit(1);
  }
}

// ================================================================
//  ЛОГИРОВАНИЕ
// ================================================================
const logFile = path.join(C.outDir, 'bot.log');

function log(...args) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch (_) {}
}

// ================================================================
//  ХРАНИЛИЩЕ СОСТОЯНИЯ
// ================================================================
const stateFile = path.join(C.outDir, 'state.json');

function loadState() {
  try {
    if (fs.existsSync(stateFile))
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {}
  return { known: {}, lastCount: null, firstRun: true };
}

function saveState(s) {
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
}

let STATE = loadState();

// ================================================================
//  TELEGRAM
// ================================================================
const TG_API = `https://api.telegram.org/bot${C.tgToken}`;

async function tgText(text, extra = {}) {
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id:    C.tgChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    }, { timeout: 15000 });
  } catch (e) {
    log('TG text error:', e.message);
  }
}

async function tgPhoto(filePath, caption = '') {
  try {
    const form = new FormData();
    form.append('chat_id',    C.tgChatId);
    form.append('photo',      fs.createReadStream(filePath));
    form.append('caption',    caption.slice(0, 1024));
    form.append('parse_mode', 'HTML');
    await axios.post(`${TG_API}/sendPhoto`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });
  } catch (e) {
    log('TG photo error:', e.message);
  }
}

// Кнопка "Открыть на IBW" — прямая ссылка на страницу квартиры
function tgInlineBtn(url, label = '📋 Открыть на inberlinwohnen.de') {
  return { inline_keyboard: [[{ text: label, url }]] };
}

// ================================================================
//  СООБЩЕНИЯ
// ================================================================
function msgNewApt(apt) {
  const lines = [
    '🏠 <b>Новая квартира!</b>',
    '',
    apt.title   ? `<b>${apt.title}</b>`                        : null,
    apt.address ? `📍 ${apt.address}`                          : null,
    apt.district? `🗺 Район: ${apt.district}`                  : null,
    apt.rooms   ? `🛏 Комнат: <b>${apt.rooms}</b>`             : null,
    apt.size    ? `📐 Площадь: <b>${apt.size} м²</b>`          : null,
    apt.rent    ? `💶 Kaltmiete: <b>${apt.rent} €</b>`         : null,
    apt.company ? `🏢 Компания: ${apt.company}`                : null,
    apt.wbs     ? `🔑 WBS: ${apt.wbs}`                        : null,
  ].filter(Boolean).join('\n');

  return { text: lines, markup: tgInlineBtn(apt.url) };
}

function msgRemovedApt(apt) {
  return [
    '❌ <b>Квартира снята с публикации</b>',
    '',
    apt.title   ? apt.title                                    : null,
    apt.address ? `📍 ${apt.address}`                         : null,
    apt.rooms   ? `🛏 ${apt.rooms} комн.`                     : null,
    apt.rent    ? `💶 ${apt.rent} €`                          : null,
    `🔗 ${apt.url}`,
  ].filter(Boolean).join('\n');
}

// ================================================================
//  БРАУЗЕР — АВТОРИЗАЦИЯ
// ================================================================
async function doLogin(page) {
  log('Авторизация...');

  await page.goto(C.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);

  // Принять cookies если есть попап
  for (const sel of ['button:has-text("Alle akzeptieren")', 'button:has-text("Akzeptieren")', '#acceptAll']) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await page.waitForTimeout(800);
        break;
      }
    } catch (_) {}
  }

  // Поле email
  await page.locator('input[type="email"], input[name="email"]').first().fill(C.email);
  // Поле пароля
  await page.locator('input[type="password"], input[name="password"]').first().fill(C.password);

  // Чекбокс "Eingeloggt bleiben" (остаться в системе)
  try {
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.isVisible({ timeout: 1000 })) await cb.check();
  } catch (_) {}

  // Нажать кнопку входа
  await page.locator('button[type="submit"], input[type="submit"]').first().click();

  // Ждём редиректа после логина
  await page.waitForURL(url => !url.includes('/login'), { timeout: 20000 })
    .catch(async () => {
      // Если не редиректнуло — проверяем текст страницы
      const body = await page.locator('body').innerText().catch(() => '');
      if (body.includes('Diese E-Mail') || body.includes('falsches Passwort') || body.includes('Ungültige')) {
        throw new Error('Неверный email или пароль. Проверь .env файл.');
      }
    });

  await page.waitForTimeout(2000);
  log('✅ Авторизован');
}

// ================================================================
//  ПАРСИНГ КВАРТИР
// ================================================================
async function scrape(page) {
  log('Загружаю страницу поиска квартир...');

  // Перехватываем XHR-запросы — сайт грузит квартиры через API
  const apiResponses = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    const ct  = resp.headers()['content-type'] || '';
    // Ловим JSON ответы которые могут содержать квартиры
    if (ct.includes('application/json') &&
        (url.includes('wohnungsfinder') || url.includes('apartment') ||
         url.includes('wohnung') || url.includes('search') || url.includes('filter'))) {
      try {
        const json = await resp.json();
        apiResponses.push({ url, json });
        log('API ответ от:', url.slice(0, 80));
        fs.writeFileSync(path.join(C.outDir, 'api_response.json'),
          JSON.stringify({ url, json }, null, 2));
      } catch (_) {}
    }
  });

  await page.goto(C.finderUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  // Ждём загрузки квартир
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Применяем фильтры
  await applyFilters(page);

  // Ждём обновления результатов
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Скриншот результатов
  const ssPath = path.join(C.outDir, 'results.png');
  await page.screenshot({ path: ssPath, fullPage: false });

  // Сначала пробуем данные из перехваченных API запросов
  let apartments = [];
  if (apiResponses.length > 0) {
    apartments = parseApiResponse(apiResponses);
    log(`Из API извлечено квартир: ${apartments.length}`);
  }

  // Если API не дал данных — парсим HTML страницу
  if (apartments.length === 0) {
    apartments = await parseHtml(page);
    log(`Из HTML извлечено квартир: ${apartments.length}`);
  }

  return { apartments, ssPath };
}

// ================================================================
//  ПРИМЕНЕНИЕ ФИЛЬТРОВ НА СТРАНИЦЕ
// ================================================================
async function applyFilters(page) {
  log('Применяю фильтры (цена, комнаты)...');

  let filtersApplied = false;

  // Попытка найти и открыть фильтр-панель
  for (const sel of [
    'button:has-text("Suchfilter")',
    'button:has-text("Filter")',
    '[class*="filter"] button',
    '.filter-toggle',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click();
        await page.waitForTimeout(1000);
        break;
      }
    } catch (_) {}
  }

  // ── Максимальная аренда ──
  const rentSelectors = [
    'input[name*="rent_max"]', 'input[name*="miete_max"]',
    'input[placeholder*="max"]', 'input[id*="rent-max"]',
    'input[id*="preis_max"]', 'input[name="max_rent"]',
    '[class*="rent"] input[type="number"]',
    '[class*="miete"] input[type="number"]',
  ];
  for (const sel of rentSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.triple_click?.() || await el.click({ clickCount: 3 });
        await el.fill(String(C.maxRent));
        log('Цена заполнена:', sel);
        filtersApplied = true;
        break;
      }
    } catch (_) {}
  }

  // ── Минимальное количество комнат ──
  const roomSelectors = [
    'input[name*="rooms_min"]', 'input[name*="zimmer_min"]',
    'input[id*="rooms-from"]', 'select[name*="rooms"]',
    'select[name*="zimmer"]', '[class*="rooms"] input',
    '[class*="zimmer"] input',
  ];
  for (const sel of roomSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        const tag = await el.evaluate(e => e.tagName);
        if (tag === 'SELECT') {
          await el.selectOption({ value: String(C.minRooms) });
        } else {
          await el.click({ clickCount: 3 });
          await el.fill(String(C.minRooms));
        }
        log('Комнаты заполнены:', sel);
        filtersApplied = true;
        break;
      }
    } catch (_) {}
  }

  // ── Кнопка "Suchen" / "Anwenden" ──
  if (filtersApplied) {
    for (const sel of [
      'button:has-text("Suchen")', 'button:has-text("Anwenden")',
      'button:has-text("Filter")', 'input[type="submit"]',
      'button[type="submit"]',
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          log('Кнопка поиска нажата');
          break;
        }
      } catch (_) {}
    }
  } else {
    log('⚠️ Фильтры не найдены — мониторинг без фильтра, фильтрую программно');
  }
}

// ================================================================
//  РАЗБОР API ОТВЕТОВ (XHR/fetch)
// ================================================================
function parseApiResponse(responses) {
  const result = [];

  for (const { url, json } of responses) {
    // Ищем массив квартир в разных форматах ответа
    let items = [];

    if (Array.isArray(json)) {
      items = json;
    } else if (json.data && Array.isArray(json.data)) {
      items = json.data;
    } else if (json.apartments && Array.isArray(json.apartments)) {
      items = json.apartments;
    } else if (json.wohnungen && Array.isArray(json.wohnungen)) {
      items = json.wohnungen;
    } else if (json.results && Array.isArray(json.results)) {
      items = json.results;
    } else {
      // Рекурсивно ищем массивы с данными квартир
      items = findApartmentArray(json);
    }

    for (const item of items) {
      const apt = normalizeApiItem(item);
      if (apt && passesFilter(apt)) result.push(apt);
    }
  }

  return deduplicate(result);
}

function findApartmentArray(obj, depth = 0) {
  if (depth > 4 || !obj || typeof obj !== 'object') return [];
  for (const key of Object.keys(obj)) {
    if (Array.isArray(obj[key]) && obj[key].length > 0) {
      const first = obj[key][0];
      if (first && typeof first === 'object' &&
          (first.id || first.rent || first.miete || first.price || first.url || first.link)) {
        return obj[key];
      }
    }
    const found = findApartmentArray(obj[key], depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

function normalizeApiItem(item) {
  if (!item || typeof item !== 'object') return null;

  // Извлекаем поля из разных возможных структур API
  const rent = parseFloat(
    item.rent || item.kaltmiete || item.cold_rent || item.preis ||
    item.miete || item.price || item.kaltmiete_in_euro || 0
  ) || 0;

  const rooms = parseFloat(
    item.rooms || item.zimmer || item.room_count || item.anzahl_zimmer || 0
  ) || 0;

  const size = parseFloat(
    item.size || item.area || item.flaeche || item.wohnflaeche ||
    item.living_area || 0
  ) || 0;

  // Ищем URL объекта
  let url = item.url || item.link || item.href || item.expose_url ||
            item.detail_url || item.object_url || '';
  if (url && !url.startsWith('http')) {
    url = C.baseUrl + (url.startsWith('/') ? '' : '/') + url;
  }
  if (!url && item.id) {
    url = `${C.baseUrl}/wohnungsfinder/?id=${item.id}`;
  }
  if (!url) url = C.finderUrl;

  const id = item.id || item.object_id || item.expose_id || url;

  return {
    id:       String(id),
    url,
    title:    item.title || item.bezeichnung || item.name || '',
    address:  item.address || item.adresse || item.strasse || item.street || '',
    district: item.district || item.bezirk || item.stadtteil || item.ortsteil || '',
    company:  item.company || item.gesellschaft || item.anbieter || item.provider || '',
    rent:     rent  > 0 ? rent.toFixed(2)   : '',
    rooms:    rooms > 0 ? rooms.toString()  : '',
    size:     size  > 0 ? size.toString()   : '',
    wbs:      item.wbs || item.wbs_required || '',
  };
}

// ================================================================
//  РАЗБОР HTML (запасной вариант)
// ================================================================
async function parseHtml(page) {
  const result = [];

  // Список возможных селекторов карточек квартир
  const cardSelectors = [
    '.wohnungsfinder-ergebnis',
    '.apartment-card',
    '.wohnung-card',
    '.result-item',
    '.listing-item',
    '[class*="result"]',
    '[class*="apartment"]',
    '[class*="wohnung"]',
    'article',
    'li[class*="item"]',
  ];

  let cards = null;

  for (const sel of cardSelectors) {
    try {
      const count = await page.locator(sel).count();
      if (count >= 2) {  // минимум 2 карточки чтобы не поймать случайный элемент
        log(`HTML карточки найдены (${sel}): ${count}`);
        cards = page.locator(sel);
        break;
      }
    } catch (_) {}
  }

  if (!cards) {
    log('Карточки HTML не найдены, сохраняю страницу для анализа...');
    const html = await page.content();
    fs.writeFileSync(path.join(C.outDir, 'page.html'), html);

    // Пробуем поискать по тексту с ценами
    return await parseByLinks(page);
  }

  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    try {
      const card = cards.nth(i);
      const apt  = await extractCardData(card);
      if (apt && passesFilter(apt)) result.push(apt);
    } catch (_) {}
  }

  return deduplicate(result);
}

async function extractCardData(card) {
  const text = await card.innerText().catch(() => '');
  if (!text || text.length < 15) return null;

  // Ссылка на объект
  let url = '';
  try {
    const links = await card.locator('a[href]').all();
    for (const link of links) {
      const href = await link.getAttribute('href') || '';
      if (href.includes('wohnungsfinder') || href.includes('expose') ||
          href.includes('objekt') || href.includes('wohnung') || href.match(/\/\d+/)) {
        url = href.startsWith('http') ? href : C.baseUrl + href;
        break;
      }
    }
    // Берём первую ссылку если специфичная не найдена
    if (!url) {
      const firstHref = await card.locator('a').first().getAttribute('href').catch(() => '');
      if (firstHref) url = firstHref.startsWith('http') ? firstHref : C.baseUrl + firstHref;
    }
  } catch (_) {}

  if (!url) url = C.finderUrl;

  const rent  = extractNum(text, /(\d[\d\s.,]*)\s*€/);
  const rooms = extractNum(text, /(\d[,.]?\d*)\s*(Zimmer|Zi\b)/i);
  const size  = extractNum(text, /(\d[\d.,]*)\s*m²/i);

  const id = url !== C.finderUrl ? url : `${rent}_${rooms}_${size}_${text.slice(0, 30)}`;

  return {
    id,
    url,
    title:    '',
    address:  extractAddress(text),
    district: extractDistrict(text),
    company:  extractCompany(text),
    rent:     rent  != null ? rent.toFixed(2)  : '',
    rooms:    rooms != null ? rooms.toString() : '',
    size:     size  != null ? size.toString()  : '',
    wbs:      text.match(/WBS/i) ? 'Требуется WBS' : '',
  };
}

async function parseByLinks(page) {
  const result = [];
  const links  = await page.locator('a[href]').all();

  for (const link of links) {
    try {
      const href = await link.getAttribute('href') || '';
      if (!href || href === '#' || href.startsWith('mailto')) continue;

      // Ищем ссылки на объекты (числовые ID или expose/wohnung в пути)
      if (!href.match(/\/\d{4,}|expose|wohnung|objekt|apartment/i)) continue;

      const fullUrl = href.startsWith('http') ? href : C.baseUrl + href;

      // Берём текст родительского блока
      const parentText = await link.evaluate(el => {
        let p = el.parentElement;
        for (let i = 0; i < 4; i++) {
          if (!p) break;
          const t = p.innerText || '';
          if (t.includes('€') && t.length > 20) return t;
          p = p.parentElement;
        }
        return el.innerText || '';
      }).catch(() => '');

      const rent  = extractNum(parentText, /(\d[\d\s.,]*)\s*€/);
      const rooms = extractNum(parentText, /(\d[,.]?\d*)\s*(Zimmer|Zi\b)/i);
      const size  = extractNum(parentText, /(\d[\d.,]*)\s*m²/i);

      if (result.find(a => a.id === fullUrl)) continue;

      result.push({
        id:       fullUrl,
        url:      fullUrl,
        title:    '',
        address:  extractAddress(parentText),
        district: extractDistrict(parentText),
        company:  extractCompany(parentText),
        rent:     rent  != null ? rent.toFixed(2)  : '',
        rooms:    rooms != null ? rooms.toString() : '',
        size:     size  != null ? size.toString()  : '',
        wbs:      parentText.match(/WBS/i) ? 'Требуется WBS' : '',
      });
    } catch (_) {}
  }

  return result.filter(passesFilter);
}

// ================================================================
//  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ПАРСИНГА
// ================================================================
function extractNum(text, rx) {
  const m = text.match(rx);
  if (!m) return null;
  return parseFloat(m[1].replace(/\s/g, '').replace(',', '.')) || null;
}

function extractAddress(text) {
  const m = text.match(/([A-Za-zÄÖÜäöüß\-.\s]+(?:straße|str\.|allee|weg|platz|damm|ring|chaussee|ufer)[^\n,]{0,30})/i);
  return m ? m[1].trim() : '';
}

function extractDistrict(text) {
  const districts = [
    'Mitte','Tiergarten','Wedding','Prenzlauer Berg','Friedrichshain',
    'Kreuzberg','Pankow','Weißensee','Heinersdorf','Buchholz',
    'Charlottenburg','Wilmersdorf','Spandau','Steglitz','Zehlendorf',
    'Tempelhof','Schöneberg','Neukölln','Treptow','Köpenick',
    'Marzahn','Hellersdorf','Lichtenberg','Hohenschönhausen',
    'Reinickendorf','Wittenau','Tegel','Buch','Niederschöneweide',
  ];
  for (const d of districts) {
    if (text.includes(d)) return d;
  }
  return '';
}

function extractCompany(text) {
  const companies = ['degewo','GESOBAU','Gewobag','HOWOGE','STADT UND LAND','WBM','berlinovo'];
  for (const c of companies) {
    if (text.toLowerCase().includes(c.toLowerCase())) return c;
  }
  return '';
}

function passesFilter(apt) {
  const rent  = parseFloat(apt.rent)  || 0;
  const rooms = parseFloat(apt.rooms) || 0;
  // Пропускаем если данных нет (не можем отфильтровать)
  if (rent  > 0 && rent  > C.maxRent + 30) return false;
  if (rooms > 0 && rooms < C.minRooms)     return false;
  return true;
}

function deduplicate(items) {
  const seen = new Set();
  return items.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

// ================================================================
//  ОСНОВНОЙ ЦИКЛ
// ================================================================
let browser = null;
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

    ctx  = await browser.newContext({
      locale:     'de-DE',
      timezoneId: 'Europe/Berlin',
      viewport:   { width: 1280, height: 900 },
      userAgent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(30000);

    // Логин
    await doLogin(page);

    // Парсинг
    const { apartments, ssPath } = await scrape(page);

    // Сравнение с предыдущим состоянием
    const prevKnown  = STATE.known || {};
    const currMap    = {};
    for (const a of apartments) currMap[a.id] = a;

    const added   = apartments.filter(a => !prevKnown[a.id]);
    const removed = Object.values(prevKnown).filter(a => !currMap[a.id]);

    log(`Квартир сейчас: ${apartments.length} | Новых: ${added.length} | Ушло: ${removed.length}`);

    // ── Первый запуск ──
    if (STATE.firstRun) {
      STATE.firstRun = false;
      await tgText(
        `🤖 <b>Бот запущен!</b>\n\n` +
        `🔍 Мониторю inberlinwohnen.de\n` +
        `💶 Kaltmiete до ${C.maxRent} €\n` +
        `🛏 Комнат от ${C.minRooms}\n` +
        `⏱ Проверка каждые ${C.intervalMs / 60000} мин\n\n` +
        `📊 Сейчас по фильтру: <b>${apartments.length} квартир</b>`
      );
      if (fs.existsSync(ssPath)) {
        await tgPhoto(ssPath, `Текущий вид страницы поиска (${apartments.length} квартир)`);
      }
    }

    // ── Уведомления о новых квартирах ──
    for (const apt of added) {
      log('НОВАЯ:', apt.id);
      const { text, markup } = msgNewApt(apt);
      await tgText(text, { reply_markup: markup });
      await sleep(600);
    }

    // ── Уведомления об ушедших квартирах ──
    for (const apt of removed) {
      log('УШЛА:', apt.id);
      await tgText(msgRemovedApt(apt));
      await sleep(600);
    }

    // Изменилось количество без чётких совпадений по ID
    if (!STATE.firstRun &&
        STATE.lastCount !== null &&
        STATE.lastCount !== apartments.length &&
        added.length === 0 && removed.length === 0) {
      await tgText(
        `📊 Количество квартир изменилось: ` +
        `<b>${STATE.lastCount} → ${apartments.length}</b>`
      );
    }

    STATE.known     = currMap;
    STATE.lastCount = apartments.length;
    saveState(STATE);

    errCount = 0;

  } catch (e) {
    errCount++;
    log('ОШИБКА:', e.message);

    if (errCount <= 3) {
      await tgText(`⚠️ Ошибка (#${errCount}):\n<code>${e.message}</code>`).catch(() => {});
    } else if (errCount === 4) {
      await tgText(`🚨 ${errCount} ошибки подряд. Бот продолжает попытки.`).catch(() => {});
    }

    // Перезапускаем браузер при частых ошибках
    if (errCount % 3 === 0) {
      try { if (browser) await browser.close(); } catch (_) {}
      browser = null;
    }

  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { if (ctx)  await ctx.close();  } catch (_) {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ================================================================
//  СТАРТ
// ================================================================
async function main() {
  checkConfig();
  log('=== Бот inberlinwohnen.de запущен ===');

  await runCheck();

  setInterval(() => {
    log('--- Плановая проверка ---');
    runCheck();
  }, C.intervalMs);
}

process.on('SIGINT',  async () => { try { await browser?.close(); } catch (_) {} process.exit(0); });
process.on('SIGTERM', async () => { try { await browser?.close(); } catch (_) {} process.exit(0); });
process.on('uncaughtException', async (e) => {
  log('UNCAUGHT:', e.stack);
  try { await tgText(`💥 Критическая ошибка:\n<code>${e.message}</code>`); } catch (_) {}
});

main().catch(async e => {
  log('FATAL:', e.stack);
  try { await tgText(`💥 Бот не запустился:\n${e.message}`); } catch (_) {}
  process.exit(1);
});
