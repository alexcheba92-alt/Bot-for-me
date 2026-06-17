'use strict';

/**
 * ================================================================
 *  inberlinwohnen.de — Бот мониторинга квартир
 * ================================================================
 *  Переменные Railway:
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

  maxRent:    600,  // Kaltmiete макс €
  minRooms:   3,    // минимум комнат

  intervalMs: 5 * 60 * 1000,

  loginUrl:  'https://www.inberlinwohnen.de/login',
  finderUrl: 'https://www.inberlinwohnen.de/wohnungsfinder',
  baseUrl:   'https://www.inberlinwohnen.de',

  outDir: path.join(__dirname, 'out'),
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

function btn(url) {
  return { inline_keyboard: [[{ text: '🔗 Открыть на inberlinwohnen.de', url }]] };
}

// ================================================================
//  СООБЩЕНИЯ
// ================================================================
function msgNew(apt) {
  const lines = [
    '🏠 <b>Новая квартира!</b>',
    '',
    apt.title   ? `<b>${apt.title}</b>`            : null,
    apt.address ? `📍 ${apt.address}`              : null,
    apt.district? `🗺 ${apt.district}`             : null,
    apt.rooms   ? `🛏 Комнат: <b>${apt.rooms}</b>` : null,
    apt.size    ? `📐 <b>${apt.size} м²</b>`       : null,
    apt.rent    ? `💶 Kaltmiete: <b>${apt.rent} €</b>` : null,
    apt.company ? `🏢 ${apt.company}`              : null,
    apt.wbs     ? `🔑 ${apt.wbs}`                 : null,
  ].filter(Boolean).join('\n');
  return { text: lines, markup: btn(apt.url) };
}

function msgGone(apt) {
  return [
    '❌ <b>Квартира снята</b>',
    '',
    apt.title   ? apt.title                     : null,
    apt.address ? `📍 ${apt.address}`           : null,
    apt.rooms   ? `🛏 ${apt.rooms} комн.`       : null,
    apt.size    ? `📐 ${apt.size} м²`           : null,
    apt.rent    ? `💶 ${apt.rent} €`            : null,
    `🔗 ${apt.url}`,
  ].filter(Boolean).join('\n');
}

// ================================================================
//  АВТОРИЗАЦИЯ
// ================================================================
async function doLogin(page) {
  log('Авторизация...');
  await page.goto(C.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);

  // Закрыть cookie-попап
  for (const s of ['button:has-text("Alle akzeptieren")', 'button:has-text("Akzeptieren")', 'button:has-text("Speichern")']) {
    try {
      const b = page.locator(s).first();
      if (await b.isVisible({ timeout: 2000 })) { await b.click(); await page.waitForTimeout(800); break; }
    } catch (_) {}
  }

  await page.locator('input[type="email"], input[name="email"]').first().fill(C.email);
  await page.locator('input[type="password"], input[name="password"]').first().fill(C.password);

  // Чекбокс "остаться в системе"
  try {
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.isVisible({ timeout: 1000 })) await cb.check();
  } catch (_) {}

  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await page.waitForURL(u => !u.includes('/login'), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  log('✅ Авторизован, URL:', page.url());
}

// ================================================================
//  ПАРСИНГ — ПЕРЕХВАТ API + HTML FALLBACK
// ================================================================
async function scrape(page) {
  log('Загружаю wohnungsfinder...');

  // Собираем ВСЕ JSON-ответы сети
  const captured = [];
  page.on('response', async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      const url = resp.url();
      const json = await resp.json().catch(() => null);
      if (!json) return;
      // Сохраняем всё — разберёмся потом
      captured.push({ url, json });
      // Логируем все JSON эндпоинты для диагностики
      log('JSON API:', url.slice(0, 100));
      // Сохраняем каждый ответ отдельным файлом
      const fname = 'api_' + url.replace(/[^a-z0-9]/gi, '_').slice(-40) + '.json';
      fs.writeFileSync(path.join(C.outDir, fname), JSON.stringify(json, null, 2));
    } catch (_) {}
  });

  await page.goto(C.finderUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);

  // Закрыть cookie-попап если появился
  for (const s of ['button:has-text("Alle akzeptieren")', 'button:has-text("Speichern")']) {
    try {
      const b = page.locator(s).first();
      if (await b.isVisible({ timeout: 1500 })) { await b.click(); await page.waitForTimeout(800); }
    } catch (_) {}
  }

  // Ждём загрузки контента
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Скриншот
  const ssPath = path.join(C.outDir, 'results.png');
  await page.screenshot({ path: ssPath, fullPage: false });

  // ── Шаг 1: пробуем данные из API ──
  let apartments = [];
  if (captured.length > 0) {
    apartments = extractFromApi(captured);
    log(`API: извлечено ${apartments.length} квартир из ${captured.length} JSON-ответов`);
  }

  // ── Шаг 2: если API не дал — парсим DOM ──
  if (apartments.length === 0) {
    log('API пустой, парсю DOM...');
    apartments = await extractFromDom(page);
    log(`DOM: извлечено ${apartments.length} квартир`);
  }

  // Дебаг первых 5
  apartments.slice(0, 5).forEach((a, i) =>
    log(`[${i}] rooms=${a.rooms} rent=${a.rent}€ size=${a.size}m² addr=${a.address} url=${a.url.slice(0, 70)}`)
  );

  return { apartments, ssPath };
}

// ================================================================
//  ИЗВЛЕЧЕНИЕ ИЗ API
// ================================================================
function extractFromApi(captured) {
  const result = [];

  for (const { url, json } of captured) {
    const items = findArray(json);
    if (items.length === 0) continue;
    log(`  Массив из ${url.slice(0, 60)}: ${items.length} элементов`);

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const apt = normalizeItem(item);
      if (apt) result.push(apt);
    }
  }

  return dedupe(result.filter(passesFilter));
}

// Рекурсивно ищем массив объектов похожих на квартиры
function findArray(obj, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== 'object') return [];

  if (Array.isArray(obj) && obj.length > 0) {
    const first = obj[0];
    if (first && typeof first === 'object' && hasAptFields(first)) return obj;
  }

  for (const key of Object.keys(obj)) {
    if (Array.isArray(obj[key]) && obj[key].length > 0) {
      const first = obj[key][0];
      if (first && typeof first === 'object' && hasAptFields(first)) return obj[key];
    }
    const found = findArray(obj[key], depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

function hasAptFields(o) {
  const keys = Object.keys(o).join(' ').toLowerCase();
  return keys.includes('rent') || keys.includes('miete') || keys.includes('zimmer') ||
         keys.includes('rooms') || keys.includes('wohnfl') || keys.includes('price') ||
         keys.includes('address') || keys.includes('strasse') || keys.includes('expose');
}

function normalizeItem(item) {
  // Все возможные поля немецкого API недвижимости
  const rent = toFloat(
    item.kaltmiete || item.kaltmiete_in_euro || item.rent || item.cold_rent ||
    item.miete || item.price || item.gesamtmiete || item.warmmiete ||
    item['kaltmiete-in-euro'] || 0
  );

  const rooms = toFloat(
    item.zimmer || item.zimmeranzahl || item.rooms || item.room_count ||
    item.anzahl_zimmer || item['anzahl-zimmer'] || item.zimmeranzahl_gesamt || 0
  );

  const size = toFloat(
    item.wohnflaeche || item.flaeche || item.size || item.area ||
    item.wohnfl || item['wohn-flaeche'] || item.living_area || 0
  );

  // URL объекта
  let url = item.url || item.link || item.href || item.expose_url ||
            item.detail_url || item.object_url || item.deeplink || '';
  if (url && !url.startsWith('http')) url = C.baseUrl + (url.startsWith('/') ? '' : '/') + url;
  if (!url && (item.id || item.expose_id || item.objekt_id)) {
    const id = item.id || item.expose_id || item.objekt_id;
    url = `${C.baseUrl}/wohnungsfinder/?objekt=${id}`;
  }
  if (!url) url = C.finderUrl;

  const id = String(item.id || item.expose_id || item.objekt_id || item.object_id || url);

  const address = [
    item.strasse || item.street || item.adresse || item.address || '',
    item.hausnummer || item.house_number || '',
  ].filter(Boolean).join(' ').trim() || item.standort || item.location || '';

  return {
    id,
    url,
    title:    item.titel || item.title || item.bezeichnung || item.name || '',
    address,
    district: item.bezirk || item.district || item.stadtteil || item.ortsteil ||
              item.stadtbezirk || item.neighbourhood || '',
    company:  item.gesellschaft || item.company || item.anbieter ||
              item.unternehmen || item.provider || '',
    rent:     rent  > 0 ? rent.toFixed(2)  : '',
    rooms:    rooms > 0 ? String(rooms)    : '',
    size:     size  > 0 ? String(size)     : '',
    wbs:      item.wbs || item.wbs_required || item.wbs_typ || '',
  };
}

// ================================================================
//  ИЗВЛЕЧЕНИЕ ИЗ DOM (запасной)
// ================================================================
async function extractFromDom(page) {
  // Сохраняем HTML для анализа
  const html = await page.content();
  fs.writeFileSync(path.join(C.outDir, 'page.html'), html);

  const result = [];

  // Пробуем разные селекторы карточек
  const selectors = [
    '[class*="result"]', '[class*="Result"]',
    '[class*="apartment"]', '[class*="Apartment"]',
    '[class*="wohnung"]', '[class*="Wohnung"]',
    '[class*="listing"]', '[class*="card"]',
    'article', 'li[class]',
  ];

  let locator = null;
  for (const sel of selectors) {
    try {
      const count = await page.locator(sel).count();
      if (count >= 3 && count <= 100) {
        log(`DOM селектор "${sel}": ${count} элементов`);
        locator = page.locator(sel);
        break;
      }
    } catch (_) {}
  }

  if (!locator) {
    log('Карточки не найдены, пробую по ссылкам...');
    return extractByLinks(page);
  }

  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    try {
      const card = locator.nth(i);
      const apt  = await parseCard(card);
      if (apt && passesFilter(apt)) result.push(apt);
    } catch (_) {}
  }

  return dedupe(result);
}

async function parseCard(card) {
  const text = await card.innerText().catch(() => '');
  if (!text || text.trim().length < 10) return null;

  // Ищем ссылку на объект внутри карточки
  let url = C.finderUrl;
  try {
    const allLinks = await card.locator('a[href]').all();
    for (const link of allLinks) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      // Приоритет: ссылки с ID объекта или ключевыми словами
      if (href.match(/\d{4,}/) || href.includes('expose') || href.includes('objekt') ||
          href.includes('wohnung') || href.includes('apartment')) {
        url = href.startsWith('http') ? href : C.baseUrl + href;
        break;
      }
    }
    // Если не нашли специфичную — берём первую ссылку
    if (url === C.finderUrl && allLinks.length > 0) {
      const href = (await allLinks[0].getAttribute('href') || '').trim();
      if (href && href !== '#') url = href.startsWith('http') ? href : C.baseUrl + href;
    }
  } catch (_) {}

  // Парсим числа из текста карточки
  // Комнаты: "3 Zimmer", "3-Zimmer", "Zi.: 3", "3 Zi."
  const rooms = extractNum(text, /(\d+(?:[.,]\d+)?)\s*(?:Zimmer|Zi\.|Zi\b)/i)
             || extractNum(text, /(\d+(?:[.,]\d+)?)-Zimmer/i)
             || extractNum(text, /(?:Zimmer|Zi\.)[:\s]*(\d+(?:[.,]\d+)?)/i);

  // Аренда: "466,94 €", "466.94 €", "466 €" — но не дробные копейки типа "1.38"
  // Ищем числа от 100 до 9999 перед знаком €
  const rentMatch = text.match(/(\d{3,4}(?:[.,]\d{1,2})?)\s*€/);
  const rent = rentMatch ? toFloat(rentMatch[1]) : null;

  // Площадь: "70,28 m²", "70 qm"
  const size = extractNum(text, /(\d+(?:[.,]\d+)?)\s*m²/i)
            || extractNum(text, /(\d+(?:[.,]\d+)?)\s*qm/i);

  const id = url !== C.finderUrl ? url : `apt_${rent}_${rooms}_${size}_${text.slice(0,20).trim()}`;

  return {
    id,
    url,
    title:    '',
    address:  extractAddress(text),
    district: extractDistrict(text),
    company:  extractCompany(text),
    rent:     rent  != null ? rent.toFixed(2)  : '',
    rooms:    rooms != null ? String(rooms)    : '',
    size:     size  != null ? String(size)     : '',
    wbs:      /WBS/i.test(text) ? 'Требуется WBS' : '',
  };
}

async function extractByLinks(page) {
  const result = [];
  const links  = await page.locator('a[href]').all();

  for (const link of links) {
    try {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#' || href.startsWith('mailto') || href.startsWith('tel')) continue;
      if (!href.match(/\d{4,}|expose|objekt|wohnung|apartment/i)) continue;

      const fullUrl = href.startsWith('http') ? href : C.baseUrl + href;
      if (result.find(a => a.id === fullUrl)) continue;

      // Берём текст из родителей (до 5 уровней вверх)
      const parentText = await link.evaluate(el => {
        let node = el;
        for (let i = 0; i < 5; i++) {
          node = node.parentElement;
          if (!node) break;
          const t = node.innerText || '';
          if (t.includes('€') && t.length > 30) return t;
        }
        return el.innerText || '';
      }).catch(() => '');

      const rentMatch = parentText.match(/(\d{3,4}(?:[.,]\d{1,2})?)\s*€/);
      const rent  = rentMatch ? toFloat(rentMatch[1]) : null;
      const rooms = extractNum(parentText, /(\d+(?:[.,]\d+)?)\s*(?:Zimmer|Zi\.|Zi\b)/i)
                 || extractNum(parentText, /(\d+(?:[.,]\d+)?)-Zimmer/i);
      const size  = extractNum(parentText, /(\d+(?:[.,]\d+)?)\s*m²/i);

      result.push({
        id: fullUrl, url: fullUrl, title: '',
        address:  extractAddress(parentText),
        district: extractDistrict(parentText),
        company:  extractCompany(parentText),
        rent:     rent  != null ? rent.toFixed(2)  : '',
        rooms:    rooms != null ? String(rooms)    : '',
        size:     size  != null ? String(size)     : '',
        wbs:      /WBS/i.test(parentText) ? 'Требуется WBS' : '',
      });
    } catch (_) {}
  }

  return result.filter(passesFilter);
}

// ================================================================
//  ВСПОМОГАЛКИ
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
    'Pankow','Weißensee','Heinersdorf','Buchholz','Charlottenburg','Wilmersdorf',
    'Spandau','Steglitz','Zehlendorf','Tempelhof','Schöneberg','Neukölln',
    'Treptow','Köpenick','Marzahn','Hellersdorf','Lichtenberg','Hohenschönhausen',
    'Reinickendorf','Wittenau','Tegel','Buch','Niederschöneweide','Adlershof',
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

    ctx  = await browser.newContext({
      locale: 'de-DE', timezoneId: 'Europe/Berlin',
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

    // Изменилось количество
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
    if (errCount <= 3) await tgText(`⚠️ Ошибка #${errCount}:\n<code>${e.message}</code>`).catch(() => {});
    if (errCount % 3 === 0) { try { await browser?.close(); } catch (_) {} browser = null; }
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
