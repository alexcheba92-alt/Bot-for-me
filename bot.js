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
//  АВТОРИЗАЦИЯ — переработанная
// ================================================================
async function doLogin(page) {
  log('Авторизация...');

  await page.goto(C.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);

  // Закрываем cookie-попап (сайт блокирует клики пока он открыт)
  try {
    // Ищем кнопку "Alle akzeptieren" или "Speichern"
    const cookieBtns = [
      'text="Alle akzeptieren"',
      'text="Speichern"',
      'text="Akzeptieren"',
      '[data-cookie-accept]',
      '.cookie-accept',
    ];
    for (const sel of cookieBtns) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          log('Cookie попап закрыт');
          await page.waitForTimeout(1000);
          break;
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Ждём полной инициализации Livewire
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Скриншот ДО — шлём в Telegram для диагностики
  const ssBefore = path.join(C.outDir, 'before_login.png');
  await page.screenshot({ path: ssBefore });
  await tgPhoto(ssBefore, 'Форма входа до заполнения').catch(() => {});

  // Email
  const emailField = page.locator('input[type="email"]').first();
  await emailField.waitFor({ state: 'visible', timeout: 15000 });
  await emailField.click();
  await page.waitForTimeout(400);
  await emailField.fill(C.email);
  await page.waitForTimeout(300);
  const emailVal = await emailField.inputValue();
  log('Email введён:', emailVal === C.email ? 'OK' : 'ОШИБКА: "' + emailVal + '"');

  // Пароль
  const passField = page.locator('input[type="password"]').first();
  await passField.click();
  await page.waitForTimeout(300);
  await passField.fill(C.password);
  await page.waitForTimeout(300);
  const passLen = (await passField.inputValue()).length;
  log('Пароль введён: ' + passLen + ' символов');

  // Чекбокс
  try {
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.isVisible({ timeout: 1000 })) { await cb.check(); }
  } catch (_) {}

  // Скриншот с заполненной формой
  const ssFilled = path.join(C.outDir, 'form_filled.png');
  await page.screenshot({ path: ssFilled });
  await tgPhoto(ssFilled, 'Форма входа (заполненная)').catch(() => {});

  // Нажимаем
  const submitBtn = page.locator('button[type="submit"]').first();
  await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
  await submitBtn.click();
  log('Кнопка Log in нажата');

  await page.waitForTimeout(5000);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  log('URL после логина:', currentUrl);

  const ssAfter = path.join(C.outDir, 'after_login.png');
  await page.screenshot({ path: ssAfter });
  await tgPhoto(ssAfter, 'После Log in. URL: ' + currentUrl).catch(() => {});

  if (currentUrl.includes('/login')) {
    try {
      await page.waitForURL(u => !u.includes('/login'), { timeout: 10000 });
      log('Залогинен (редирект с задержкой), URL:', page.url());
    } catch (_) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      log('Текст после логина:', bodyText.slice(0, 300));
      if (bodyText.includes('überprüfen') || bodyText.includes('ungültig') || bodyText.includes('falsch')) {
        throw new Error('Сайт отклонил логин. Смотри скриншоты в Telegram.');
      }
      log('Залогинен (Livewire, URL не сменился)');
    }
  } else {
    log('Авторизован, URL:', currentUrl);
  }
}

// ================================================================
//  ПАРСИНГ КВАРТИР
// ================================================================
async function scrape(page) {
  log('Загружаю wohnungsfinder...');

  // Перехватываем все JSON-ответы
  const captured = [];
  page.on('response', async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('application/json') && !ct.includes('text/json')) return;
      const url = resp.url();
      const json = await resp.json().catch(() => null);
      if (!json) return;
      captured.push({ url, json });
      log('JSON от:', url.slice(0, 100));
      const fname = 'api_' + encodeURIComponent(url).slice(-50) + '.json';
      fs.writeFileSync(path.join(C.outDir, fname), JSON.stringify(json, null, 2));
    } catch (_) {}
  });

  await page.goto(C.finderUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);

  // Закрыть cookie попап если появился снова
  for (const s of ['text="Alle akzeptieren"', 'text="Speichern"']) {
    try {
      const b = page.locator(s).first();
      if (await b.isVisible({ timeout: 1500 })) { await b.click(); await page.waitForTimeout(800); }
    } catch (_) {}
  }

  // Ждём полной загрузки (Livewire грузит данные после DOMContentLoaded)
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // Скриншот
  const ssPath = path.join(C.outDir, 'results.png');
  await page.screenshot({ path: ssPath, fullPage: false });

  // Сохраняем полный HTML для анализа
  const html = await page.content();
  fs.writeFileSync(path.join(C.outDir, 'finder.html'), html);

  // ── Пробуем получить данные из Livewire snapshot в HTML ──
  let apartments = extractFromLivewire(html);
  if (apartments.length > 0) {
    log(`Livewire snapshot: ${apartments.length} квартир`);
  }

  // ── Если Livewire не дал — пробуем JSON API ──
  if (apartments.length === 0 && captured.length > 0) {
    apartments = extractFromApi(captured);
    log(`JSON API: ${apartments.length} квартир`);
  }

  // ── Если ничего — парсим DOM ──
  if (apartments.length === 0) {
    log('Парсю DOM напрямую...');
    apartments = await extractFromDom(page);
    log(`DOM: ${apartments.length} квартир`);
  }

  // Дебаг первых 5
  apartments.slice(0, 5).forEach((a, i) =>
    log(`[${i}] rooms=${a.rooms||'?'} rent=${a.rent||'?'}€ size=${a.size||'?'}m² ${a.address} | ${a.url.slice(0,70)}`)
  );

  return { apartments, ssPath };
}

// ================================================================
//  ИЗВЛЕЧЕНИЕ ИЗ LIVEWIRE SNAPSHOT (данные прямо в HTML)
// ================================================================
function extractFromLivewire(html) {
  const apartments = [];

  try {
    // Livewire хранит данные в wire:snapshot или window.livewire_snapshot
    const patterns = [
      /wire:snapshot="([^"]+)"/g,
      /wire:initial-data="([^"]+)"/g,
      /__livewire_data\s*=\s*({.+?});/gs,
    ];

    for (const rx of patterns) {
      let m;
      while ((m = rx.exec(html)) !== null) {
        try {
          const raw = m[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
          const data = JSON.parse(raw);
          const items = findApartmentArray(data);
          if (items.length > 0) {
            log(`Livewire: найден массив ${items.length} элементов`);
            for (const item of items) {
              const apt = normalizeItem(item);
              if (apt && passesFilter(apt)) apartments.push(apt);
            }
          }
        } catch (_) {}
      }
    }

    // Также ищем JSON-блоки в скриптах
    const scriptRx = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let sm;
    while ((sm = scriptRx.exec(html)) !== null) {
      const scriptContent = sm[1];
      // Ищем массивы с полями квартир
      const jsonRx = /(\[{.+?}\])/gs;
      let jm;
      while ((jm = jsonRx.exec(scriptContent)) !== null) {
        try {
          const arr = JSON.parse(jm[1]);
          if (Array.isArray(arr) && arr.length > 0 && hasAptFields(arr[0])) {
            log(`Script JSON: массив ${arr.length} элементов`);
            for (const item of arr) {
              const apt = normalizeItem(item);
              if (apt && passesFilter(apt)) apartments.push(apt);
            }
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    log('Livewire parse error:', e.message);
  }

  return dedupe(apartments);
}

// ================================================================
//  ИЗВЛЕЧЕНИЕ ИЗ API ОТВЕТОВ
// ================================================================
function extractFromApi(captured) {
  const result = [];
  for (const { url, json } of captured) {
    const items = findApartmentArray(json);
    if (items.length === 0) continue;
    log(`  API массив из ${url.slice(0,60)}: ${items.length} элементов`);
    for (const item of items) {
      const apt = normalizeItem(item);
      if (apt && passesFilter(apt)) result.push(apt);
    }
  }
  return dedupe(result);
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
  return (keys.includes('rent') || keys.includes('miete') || keys.includes('zimmer') ||
          keys.includes('rooms') || keys.includes('wohnfl') || keys.includes('expose') ||
          keys.includes('kaltmiete') || keys.includes('flaeche'));
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;

  const rent = toFloat(item.kaltmiete || item.kaltmiete_in_euro || item['kaltmiete-in-euro'] ||
    item.rent || item.cold_rent || item.miete || item.price || item.gesamtmiete || 0);

  const rooms = toFloat(item.zimmer || item.zimmeranzahl || item['anzahl-zimmer'] ||
    item.rooms || item.room_count || item.anzahl_zimmer || 0);

  const size = toFloat(item.wohnflaeche || item['wohn-flaeche'] || item.flaeche ||
    item.size || item.area || item.living_area || 0);

  let url = item.url || item.link || item.href || item.expose_url ||
            item.detail_url || item.object_url || item.deeplink || '';
  if (url && !url.startsWith('http')) url = C.baseUrl + (url.startsWith('/') ? '' : '/') + url;
  if (!url) {
    const id = item.id || item.expose_id || item.objekt_id || item.object_id;
    if (id) url = `${C.baseUrl}/wohnungsfinder/?objekt=${id}`;
    else url = C.finderUrl;
  }

  const id = String(item.id || item.expose_id || item.objekt_id || item.object_id || url);
  const address = [item.strasse || item.street || item.adresse || item.address || '',
                   item.hausnummer || item.house_number || ''].filter(Boolean).join(' ').trim()
                || item.standort || item.location || '';

  return {
    id, url,
    title:    item.titel || item.title || item.bezeichnung || item.name || '',
    address,
    district: item.bezirk || item.district || item.stadtteil || item.ortsteil || item.stadtbezirk || '',
    company:  item.gesellschaft || item.company || item.anbieter || item.unternehmen || '',
    rent:     rent  > 0 ? rent.toFixed(2)  : '',
    rooms:    rooms > 0 ? String(rooms)    : '',
    size:     size  > 0 ? String(size)     : '',
    wbs:      String(item.wbs || item.wbs_required || item.wbs_typ || ''),
  };
}

// ================================================================
//  ИЗВЛЕЧЕНИЕ ИЗ DOM
// ================================================================
async function extractFromDom(page) {
  const result = [];

  // Пробуем найти карточки
  const selectors = [
    '[wire\\:key]',          // Livewire элементы
    '[class*="result"]',
    '[class*="apartment"]',
    '[class*="wohnung"]',
    '[class*="listing"]',
    '[class*="card"]',
    'article',
    'li[class]',
  ];

  let locator = null;
  for (const sel of selectors) {
    try {
      const count = await page.locator(sel).count();
      if (count >= 3 && count <= 200) {
        log(`DOM: селектор "${sel}" → ${count} элементов`);
        locator = page.locator(sel);
        break;
      }
    } catch (_) {}
  }

  if (!locator) {
    log('DOM: карточки не найдены, парсю по ссылкам');
    return extractByLinks(page);
  }

  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    try {
      const apt = await parseCard(locator.nth(i));
      if (apt && passesFilter(apt)) result.push(apt);
    } catch (_) {}
  }

  return dedupe(result);
}

async function parseCard(card) {
  const text = await card.innerText().catch(() => '');
  if (!text || text.trim().length < 10) return null;

  // Ищем ссылку
  let url = C.finderUrl;
  try {
    const links = await card.locator('a[href]').all();
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      if (href.match(/\d{4,}/) || href.includes('expose') || href.includes('objekt') ||
          href.includes('wohnung') || href.includes('apartment')) {
        url = href.startsWith('http') ? href : C.baseUrl + href;
        break;
      }
    }
    if (url === C.finderUrl && links.length > 0) {
      const href = (await links[0].getAttribute('href') || '').trim();
      if (href && href !== '#') url = href.startsWith('http') ? href : C.baseUrl + href;
    }
  } catch (_) {}

  // Комнаты — несколько паттернов
  const rooms = extractNum(text, /(\d+(?:[.,]\d+)?)\s*Zimmer/i)
             || extractNum(text, /(\d+(?:[.,]\d+)?)-Zimmer/i)
             || extractNum(text, /Zimmer[:\s]+(\d+(?:[.,]\d+)?)/i)
             || extractNum(text, /(\d+(?:[.,]\d+)?)\s*Zi\b/i);

  // Аренда — только реалистичные суммы (100-9999 €)
  const rentMatch = text.match(/\b(\d{3,4}(?:[,.]?\d{0,2})?)\s*€/);
  const rent = rentMatch ? toFloat(rentMatch[1]) : null;

  // Площадь
  const size = extractNum(text, /(\d+(?:[.,]\d+)?)\s*m²/i)
            || extractNum(text, /(\d+(?:[.,]\d+)?)\s*qm/i);

  const id = url !== C.finderUrl ? url : `dom_${rent}_${rooms}_${text.slice(0,25).trim()}`;

  return {
    id, url,
    title:    '',
    address:  extractAddress(text),
    district: extractDistrict(text),
    company:  extractCompany(text),
    rent:     rent  != null ? rent.toFixed(2)  : '',
    rooms:    rooms != null ? String(rooms)    : '',
    size:     size  != null ? String(size)     : '',
    wbs:      /\bWBS\b/i.test(text) ? 'Требуется WBS' : '',
  };
}

async function extractByLinks(page) {
  const result = [];
  const links = await page.locator('a[href]').all();

  for (const link of links) {
    try {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#' || href.startsWith('mailto') || href.startsWith('tel')) continue;
      if (!href.match(/\d{4,}|expose|objekt|wohnung|apartment/i)) continue;

      const fullUrl = href.startsWith('http') ? href : C.baseUrl + href;
      if (result.find(a => a.id === fullUrl)) continue;

      const parentText = await link.evaluate(el => {
        let node = el;
        for (let i = 0; i < 6; i++) {
          node = node.parentElement;
          if (!node) break;
          const t = (node.innerText || '').trim();
          if (t.includes('€') && t.length > 30) return t;
        }
        return (el.innerText || '').trim();
      }).catch(() => '');

      const rentMatch = parentText.match(/\b(\d{3,4}(?:[,.]?\d{0,2})?)\s*€/);
      const rent  = rentMatch ? toFloat(rentMatch[1]) : null;
      const rooms = extractNum(parentText, /(\d+(?:[.,]\d+)?)\s*Zimmer/i)
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
        wbs:      /\bWBS\b/i.test(parentText) ? 'Требуется WBS' : '',
      });
    } catch (_) {}
  }

  return result.filter(passesFilter);
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
