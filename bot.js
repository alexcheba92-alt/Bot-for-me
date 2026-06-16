/**
 * ============================================================
 *  inberlinwohnen.de — Бот мониторинга квартир
 *  Playwright + Telegram Bot API
 *  Node.js >= 18
 * ============================================================
 *
 *  Установка:
 *    npm install playwright axios form-data
 *    npx playwright install chromium
 *
 *  Запуск:
 *    node bot.js
 *
 *  Переменные окружения (или заполни прямо здесь):
 *    IBW_LOGIN          — email от аккаунта на inberlinwohnen.de
 *    IBW_PASSWORD       — пароль
 *    TELEGRAM_TOKEN     — токен бота (@BotFather)
 *    TELEGRAM_CHAT_ID   — твой chat_id (получи у @userinfobot)
 * ============================================================
 */

'use strict';

const { chromium, devices } = require('playwright');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const FormData = require('form-data');

// ─────────────────────────────────────────────
//  НАСТРОЙКИ — заполни здесь или через env
// ─────────────────────────────────────────────
const CONFIG = {
  login:        process.env.IBW_LOGIN        || 'ВАШ_EMAIL',
  password:     process.env.IBW_PASSWORD     || 'ВАШ_ПАРОЛЬ',
  tgToken:      process.env.TELEGRAM_TOKEN   || 'ВАШ_ТОКЕН_БОТА',
  tgChatId:     process.env.TELEGRAM_CHAT_ID || 'ВАШ_CHAT_ID',

  // Параметры фильтра
  maxRent:      600,   // Kaltmiete макс.
  rooms:        2,     // количество комнат

  // Интервал проверки (миллисекунды)
  intervalMs:   5 * 60 * 1000,   // 5 минут

  // URL
  baseUrl:      'https://www.inberlinwohnen.de',
  loginUrl:     'https://www.inberlinwohnen.de/mein-bereich/',
  finderUrl:    'https://www.inberlinwohnen.de/wohnungsfinder/',

  // Папка для временных файлов
  outDir:       path.join(__dirname, 'out'),
};

// Создаём папку для логов
if (!fs.existsSync(CONFIG.outDir)) fs.mkdirSync(CONFIG.outDir, { recursive: true });

// ─────────────────────────────────────────────
//  ХРАНИЛИЩЕ СОСТОЯНИЯ (в памяти + файл)
// ─────────────────────────────────────────────
const STATE_FILE = path.join(CONFIG.outDir, 'state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { apartments: {}, lastCount: null };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

// ─────────────────────────────────────────────
//  ЛОГИРОВАНИЕ
// ─────────────────────────────────────────────
const LOG_FILE = path.join(CONFIG.outDir, 'bot.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ─────────────────────────────────────────────
//  TELEGRAM
// ─────────────────────────────────────────────
async function tgSend(text, extra = {}) {
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id:    CONFIG.tgChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (e) {
    log('TG sendMessage error:', e.message);
  }
}

async function tgSendPhoto(imagePath, caption = '') {
  try {
    const form = new FormData();
    form.append('chat_id', CONFIG.tgChatId);
    form.append('photo', fs.createReadStream(imagePath));
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.tgToken}/sendPhoto`,
      form,
      { headers: form.getHeaders() }
    );
  } catch (e) {
    log('TG sendPhoto error:', e.message);
  }
}

// Красивое сообщение о новой квартире
function buildNewApartmentMessage(apt) {
  const lines = [
    '🏠 <b>Новая квартира найдена!</b>',
    '',
    `📍 <b>Адрес / район:</b> ${apt.address || apt.district || 'не указан'}`,
    `🛏 <b>Комнат:</b> ${apt.rooms || '—'}`,
    `💶 <b>Kaltmiete:</b> ${apt.rent || '—'} €`,
    `📐 <b>Площадь:</b> ${apt.size || '—'} м²`,
    `🏢 <b>Этаж:</b> ${apt.floor || '—'}`,
    apt.extra ? `ℹ️ ${apt.extra}` : '',
    '',
    `🔗 <a href="${apt.ibwUrl}">Открыть на inberlinwohnen.de</a>`,
  ].filter(l => l !== '');

  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: '📋 Открыть анкету на IBW', url: apt.ibwUrl }
      ]]
    }
  };
}

// Сообщение об исчезнувшей квартире
function buildRemovedMessage(apt) {
  return [
    '❌ <b>Квартира снята с публикации</b>',
    '',
    `📍 ${apt.address || apt.district || 'не указан'}`,
    `🛏 ${apt.rooms || '—'} комн. | 💶 ${apt.rent || '—'} € | 📐 ${apt.size || '—'} м²`,
    `🔗 ${apt.ibwUrl}`,
  ].join('\n');
}

// ─────────────────────────────────────────────
//  БРАУЗЕР
// ─────────────────────────────────────────────
let browser = null;
let browserContext = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  log('Запускаю браузер...');
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  return browser;
}

async function getContext() {
  const b = await getBrowser();
  if (browserContext) {
    try { await browserContext.close(); } catch (e) {}
  }
  browserContext = await b.newContext({
    ...devices['iPhone 13 Pro'],
    locale:     'de-DE',
    timezoneId: 'Europe/Berlin',
    userAgent:  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  });
  return browserContext;
}

// ─────────────────────────────────────────────
//  АВТОРИЗАЦИЯ
// ─────────────────────────────────────────────
async function login(page) {
  log('Авторизация на сайте...');

  await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  // Принимаем cookies если есть диалог
  try {
    const cookieBtn = page.locator('button:has-text("Alle akzeptieren"), button:has-text("Akzeptieren"), #acceptAll, .cookie-accept');
    if (await cookieBtn.first().isVisible({ timeout: 4000 })) {
      await cookieBtn.first().click();
      await page.waitForTimeout(1000);
    }
  } catch (e) { /* нет диалога */ }

  // Ищем форму входа
  // Поле email/логин
  const emailSelectors = [
    'input[name="log"]',
    'input[type="email"]',
    'input[name="username"]',
    'input[id*="user"]',
    'input[id*="login"]',
    'input[placeholder*="E-Mail"]',
    'input[placeholder*="Benutzername"]',
  ];

  let emailFilled = false;
  for (const sel of emailSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.fill(CONFIG.login);
        emailFilled = true;
        log('Email поле найдено:', sel);
        break;
      }
    } catch (e) {}
  }

  if (!emailFilled) {
    // Скрин для диагностики
    await page.screenshot({ path: path.join(CONFIG.outDir, 'login_fail.png'), fullPage: true });
    throw new Error('Не найдено поле ввода email/логина');
  }

  // Поле пароля
  const passSelectors = [
    'input[name="pwd"]',
    'input[type="password"]',
    'input[name="password"]',
    'input[id*="pass"]',
  ];

  let passFilled = false;
  for (const sel of passSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.fill(CONFIG.password);
        passFilled = true;
        log('Password поле найдено:', sel);
        break;
      }
    } catch (e) {}
  }

  if (!passFilled) {
    await page.screenshot({ path: path.join(CONFIG.outDir, 'login_fail.png'), fullPage: true });
    throw new Error('Не найдено поле ввода пароля');
  }

  // Кнопка входа
  const submitSelectors = [
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Anmelden")',
    'button:has-text("Einloggen")',
    'button:has-text("Login")',
    '.login-submit',
    '#wp-submit',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        submitted = true;
        log('Кнопка входа нажата:', sel);
        break;
      }
    } catch (e) {}
  }

  if (!submitted) {
    await page.keyboard.press('Enter');
    log('Нажал Enter для отправки формы');
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await page.waitForTimeout(3000);

  // Проверяем что залогинились
  const url = page.url();
  const bodyText = await page.locator('body').innerText().catch(() => '');

  const isLoggedIn = (
    url.includes('mein-bereich') ||
    bodyText.includes('Mein Bereich') ||
    bodyText.includes('Abmelden') ||
    bodyText.includes('Logout') ||
    bodyText.includes('Willkommen')
  );

  if (!isLoggedIn) {
    await page.screenshot({ path: path.join(CONFIG.outDir, 'login_fail.png'), fullPage: true });
    log('Текст страницы после логина:', bodyText.slice(0, 500));
    throw new Error('Авторизация не удалась. Проверь логин/пароль.');
  }

  log('✅ Авторизация успешна');
}

// ─────────────────────────────────────────────
//  ПАРСИНГ КВАРТИР
// ─────────────────────────────────────────────
async function scrapeApartments(page) {
  log('Перехожу на страницу поиска квартир...');

  // Пробуем несколько вариантов URL поиска
  const searchUrls = [
    'https://www.inberlinwohnen.de/wohnungsfinder/',
    'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',
    'https://www.inberlinwohnen.de/wohnungen/',
  ];

  let loaded = false;
  for (const url of searchUrls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await page.waitForTimeout(3000);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (bodyText.length > 200 && !bodyText.includes('Fehler') && !bodyText.includes('404')) {
        log('Страница загружена:', url);
        loaded = true;
        break;
      }
    } catch (e) {
      log('URL не сработал:', url, e.message);
    }
  }

  if (!loaded) throw new Error('Не удалось загрузить страницу поиска квартир');

  // Применяем фильтры
  await applyFilters(page);

  // Ждём загрузки результатов
  await page.waitForTimeout(4000);
  await page.waitForLoadState('networkidle').catch(() => {});

  // Делаем скриншот результатов
  const ssPath = path.join(CONFIG.outDir, 'results.png');
  await page.screenshot({ path: ssPath, fullPage: true });

  // Парсим карточки квартир
  const apartments = await extractApartments(page);
  log(`Найдено квартир: ${apartments.length}`);

  return { apartments, screenshotPath: ssPath };
}

// ─────────────────────────────────────────────
//  ПРИМЕНЕНИЕ ФИЛЬТРОВ
// ─────────────────────────────────────────────
async function applyFilters(page) {
  log('Применяю фильтры...');

  const pageText = await page.locator('body').innerText().catch(() => '');

  // ── Фильтр по цене (Kaltmiete до 600 €) ──
  const rentSelectors = [
    'input[name*="rent_max"]',
    'input[name*="kaltmiete"]',
    'input[name*="miete_max"]',
    'input[placeholder*="max"]',
    'input[id*="rent-max"]',
    'input[id*="preis-max"]',
    '#rent_to',
    '#kaltmiete_max',
    'input[name="rent_to"]',
  ];

  for (const sel of rentSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.fill(String(CONFIG.maxRent));
        log('Поле максимальной аренды заполнено:', sel);
        break;
      }
    } catch (e) {}
  }

  // Также пробуем range slider если есть
  try {
    const slider = page.locator('[data-max*="rent"], [data-name*="rent"], input[type="range"][name*="rent"]').first();
    if (await slider.isVisible({ timeout: 1000 })) {
      await slider.fill(String(CONFIG.maxRent));
    }
  } catch (e) {}

  // ── Фильтр по комнатам (2 комнаты) ──
  const roomSelectors = [
    'input[name*="rooms_min"]',
    'input[name*="zimmer"]',
    'input[name*="rooms"]',
    'select[name*="rooms"]',
    'select[name*="zimmer"]',
    '#rooms_from',
    '#zimmer_min',
  ];

  for (const sel of roomSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        const tag = await el.evaluate(e => e.tagName.toLowerCase());
        if (tag === 'select') {
          await el.selectOption({ value: String(CONFIG.rooms) });
        } else {
          await el.fill(String(CONFIG.rooms));
        }
        log('Поле комнат заполнено:', sel);
        break;
      }
    } catch (e) {}
  }

  // Также пробуем чекбоксы/кнопки для количества комнат
  try {
    const roomBtn = page.locator(`[data-rooms="${CONFIG.rooms}"], [data-zimmer="${CONFIG.rooms}"], button:has-text("${CONFIG.rooms} Zimmer")`).first();
    if (await roomBtn.isVisible({ timeout: 1000 })) {
      await roomBtn.click();
      log('Нажата кнопка выбора комнат');
    }
  } catch (e) {}

  // ── Нажимаем кнопку Suchen/Filtern ──
  await page.waitForTimeout(500);

  const searchBtnSelectors = [
    'button[type="submit"]:has-text("Suchen")',
    'button:has-text("Suchen")',
    'input[type="submit"][value*="Suchen"]',
    'button:has-text("Filtern")',
    'button:has-text("Anwenden")',
    '.search-submit',
    '#search-submit',
    'button[type="submit"]',
  ];

  for (const sel of searchBtnSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click();
        log('Кнопка поиска нажата:', sel);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
        break;
      }
    } catch (e) {}
  }
}

// ─────────────────────────────────────────────
//  ИЗВЛЕЧЕНИЕ ДАННЫХ О КВАРТИРАХ
// ─────────────────────────────────────────────
async function extractApartments(page) {
  // Пробуем разные селекторы карточек квартир
  const cardSelectors = [
    '.wohnungsfinder-result',
    '.apartment-item',
    '.listing-item',
    '.wohnung-item',
    '.object-item',
    '.immo-item',
    'article.apartment',
    'article.listing',
    '.result-item',
    '[class*="wohnung"]',
    '[class*="apartment"]',
    '[class*="listing"]',
    'li.immo',
    '.immo-list li',
  ];

  let cards = [];

  for (const sel of cardSelectors) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) {
        log(`Найдено карточек (${sel}): ${count}`);
        cards = await page.locator(sel).all();
        break;
      }
    } catch (e) {}
  }

  // Если через селекторы не нашли — парсим HTML напрямую
  if (cards.length === 0) {
    log('Стандартные селекторы не дали результата, парсю HTML напрямую...');
    return await extractFromHTML(page);
  }

  const apartments = [];

  for (const card of cards) {
    try {
      const apt = await extractCardData(card, page);
      if (apt) apartments.push(apt);
    } catch (e) {
      log('Ошибка при парсинге карточки:', e.message);
    }
  }

  // Фильтрация по нашим критериям (на случай если сайт вернул лишнее)
  return apartments.filter(apt => {
    const rent = parseFloat(apt.rent) || 0;
    const rooms = parseFloat(apt.rooms) || 0;
    return (rent === 0 || rent <= CONFIG.maxRent + 50) &&
           (rooms === 0 || rooms >= CONFIG.rooms);
  });
}

async function extractCardData(card, page) {
  const html = await card.innerHTML().catch(() => '');
  const text = await card.innerText().catch(() => '');

  if (!text || text.length < 10) return null;

  // Ищем ссылку на квартиру
  let href = '';
  try {
    const link = card.locator('a').first();
    href = await link.getAttribute('href') || '';
    if (href && !href.startsWith('http')) {
      href = CONFIG.baseUrl + href;
    }
  } catch (e) {}

  // Если ссылки нет — пробуем id объекта из data-атрибутов
  if (!href) {
    try {
      const id = await card.getAttribute('data-id') ||
                 await card.getAttribute('data-object-id') ||
                 await card.getAttribute('data-apartment-id');
      if (id) {
        href = `${CONFIG.baseUrl}/wohnungsfinder/?object=${id}`;
      }
    } catch (e) {}
  }

  // Не добавляем без ссылки
  if (!href) href = CONFIG.finderUrl;

  // Извлекаем данные через regex из текста
  const rent  = extractNumber(text, /(\d[\d.,]*)\s*€/);
  const rooms = extractNumber(text, /(\d[.,]?\d*)\s*(Zimmer|Zi\.|Räume)/i);
  const size  = extractNumber(text, /(\d[\d.,]*)\s*m²/i);
  const floor = (text.match(/(\d+)\.\s*(?:Etage|OG|Obergeschoss)/i) || [])[1] || '';

  // Адрес / район
  const addressMatch = text.match(/(\d{5}\s+Berlin.*?)(?:\n|$)/m) ||
                       text.match(/(Berlin.{0,40})(?:\n|$)/m);
  const address = addressMatch ? addressMatch[1].trim() : '';

  // Уникальный ID для отслеживания изменений
  const id = href || `${address}_${rent}_${rooms}`;

  return {
    id,
    ibwUrl: href,
    address,
    district: extractDistrict(text + ' ' + html),
    rent:     rent  ? rent.toFixed(2)  : '',
    rooms:    rooms ? rooms.toString() : '',
    size:     size  ? size.toString()  : '',
    floor,
    extra:    '',
    rawText:  text.slice(0, 200),
  };
}

function extractNumber(text, regex) {
  const m = text.match(regex);
  if (!m) return null;
  return parseFloat(m[1].replace(',', '.'));
}

function extractDistrict(text) {
  const districts = [
    'Mitte', 'Prenzlauer Berg', 'Friedrichshain', 'Kreuzberg',
    'Pankow', 'Charlottenburg', 'Wilmersdorf', 'Spandau',
    'Steglitz', 'Zehlendorf', 'Tempelhof', 'Schöneberg',
    'Neukölln', 'Treptow', 'Köpenick', 'Marzahn', 'Hellersdorf',
    'Lichtenberg', 'Reinickendorf', 'Weißensee', 'Hohenschönhausen',
  ];
  for (const d of districts) {
    if (text.includes(d)) return d;
  }
  return '';
}

async function extractFromHTML(page) {
  // Запасной способ: ищем все ссылки и текстовые блоки с ценами
  const html = await page.content();
  const apartments = [];

  // Ищем паттерны цен €  в HTML
  const pricePattern = /(\d{3,4})\s*[,.]?\s*\d*\s*€/g;
  let m;
  const prices = new Set();
  while ((m = pricePattern.exec(html)) !== null) {
    prices.add(parseInt(m[1]));
  }

  // Ищем все ссылки на объекты
  const links = await page.locator('a[href*="wohnung"], a[href*="objekt"], a[href*="apartment"], a[href*="expose"]').all();

  for (const link of links) {
    try {
      const href = await link.getAttribute('href') || '';
      const fullHref = href.startsWith('http') ? href : CONFIG.baseUrl + href;
      const text = await link.innerText().catch(() => '');
      const parentText = await link.locator('..').innerText().catch(() => text);

      const rent  = extractNumber(parentText, /(\d[\d.,]*)\s*€/);
      if (rent && rent > CONFIG.maxRent + 100) continue;  // вне фильтра

      const rooms = extractNumber(parentText, /(\d[.,]?\d*)\s*(Zimmer|Zi\.)/i);
      const size  = extractNumber(parentText, /(\d[\d.,]*)\s*m²/i);

      const id = fullHref;
      if (apartments.find(a => a.id === id)) continue;  // дубликат

      apartments.push({
        id,
        ibwUrl: fullHref,
        address: extractDistrict(parentText) || 'Berlin',
        district: extractDistrict(parentText),
        rent:  rent  ? rent.toFixed(2)  : '',
        rooms: rooms ? rooms.toString() : '',
        size:  size  ? size.toString()  : '',
        floor: '',
        extra: '',
        rawText: parentText.slice(0, 200),
      });
    } catch (e) {}
  }

  return apartments;
}

// ─────────────────────────────────────────────
//  ОСНОВНОЙ ЦИКЛ МОНИТОРИНГА
// ─────────────────────────────────────────────
let isFirstRun = true;
let consecutiveErrors = 0;

async function runCheck() {
  let page = null;
  let ctx  = null;

  try {
    ctx  = await getContext();
    page = await ctx.newPage();
    page.setDefaultTimeout(25000);

    // Логинимся (каждый раз, т.к. контекст свежий)
    await login(page);

    // Парсим квартиры
    const { apartments, screenshotPath } = await scrapeApartments(page);

    // Строим map id -> apt
    const currentMap = {};
    for (const apt of apartments) {
      currentMap[apt.id] = apt;
    }

    const prevMap = state.apartments || {};
    const prevIds = new Set(Object.keys(prevMap));
    const currIds = new Set(Object.keys(currentMap));

    // Новые квартиры
    const added   = apartments.filter(a => !prevIds.has(a.id));
    // Пропавшие квартиры
    const removed = Object.values(prevMap).filter(a => !currIds.has(a.id));

    log(`Текущих: ${apartments.length}, новых: ${added.length}, убрано: ${removed.length}`);

    // ── Первый запуск ──
    if (isFirstRun) {
      isFirstRun = false;
      await tgSend(
        `🤖 <b>Бот запущен!</b>\n\n` +
        `🔍 Начинаю мониторинг квартир на inberlinwohnen.de\n` +
        `📊 Фильтр: до ${CONFIG.maxRent} € Kaltmiete, от ${CONFIG.rooms} комнат\n` +
        `⏱ Проверка каждые ${CONFIG.intervalMs / 60000} минут\n\n` +
        `📋 Сейчас в базе: <b>${apartments.length} квартир</b>`
      );

      if (screenshotPath && fs.existsSync(screenshotPath)) {
        await tgSendPhoto(screenshotPath, `Текущее состояние фильтра (${apartments.length} квартир)`);
      }
    }

    // ── Уведомления о новых квартирах ──
    for (const apt of added) {
      log('НОВАЯ КВАРТИРА:', apt.id);
      const msg = buildNewApartmentMessage(apt);
      await tgSend(msg.text, { reply_markup: msg.reply_markup });
      await sleep(500);  // небольшая пауза между сообщениями
    }

    // ── Уведомления об удалённых квартирах ──
    for (const apt of removed) {
      log('КВАРТИРА СНЯТА:', apt.id);
      await tgSend(buildRemovedMessage(apt));
      await sleep(500);
    }

    // ── Уведомление об изменении количества ──
    if (state.lastCount !== null && state.lastCount !== apartments.length && added.length === 0 && removed.length === 0) {
      // Количество изменилось, но id не совпадают — общее уведомление
      await tgSend(
        `📊 Количество квартир изменилось: <b>${state.lastCount} → ${apartments.length}</b>`
      );
    }

    // Сохраняем состояние
    state.apartments = currentMap;
    state.lastCount  = apartments.length;
    saveState(state);

    consecutiveErrors = 0;

  } catch (e) {
    consecutiveErrors++;
    log('ОШИБКА в runCheck:', e.stack || e.message);

    if (consecutiveErrors <= 3) {
      await tgSend(`⚠️ Ошибка проверки (#${consecutiveErrors}):\n<code>${e.message}</code>\nПродолжаю работу...`);
    } else if (consecutiveErrors === 4) {
      await tgSend(`🚨 Много ошибок подряд (${consecutiveErrors}). Проверь логи. Бот продолжает попытки.`);
    }

  } finally {
    try { if (page) await page.close(); } catch (e) {}
    try { if (ctx)  await ctx.close();  } catch (e) {}
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────
//  ТОЧКА ВХОДА
// ─────────────────────────────────────────────
async function main() {
  log('=== Бот inberlinwohnen.de стартует ===');
  log(`Фильтр: Kaltmiete до ${CONFIG.maxRent} €, комнат >= ${CONFIG.rooms}`);
  log(`Интервал: ${CONFIG.intervalMs / 1000} сек`);

  // Проверяем конфиг
  if (CONFIG.login === 'ВАШ_EMAIL' || CONFIG.tgToken === 'ВАШ_ТОКЕН_БОТА') {
    console.error('\n❌ ОШИБКА: Заполни CONFIG в начале файла!\n');
    console.error('  login    — email от аккаунта inberlinwohnen.de');
    console.error('  password — пароль');
    console.error('  tgToken  — токен Telegram бота');
    console.error('  tgChatId — твой chat_id в Telegram\n');
    process.exit(1);
  }

  // Первый запуск сразу
  await runCheck();

  // Затем каждые N минут
  setInterval(async () => {
    log('--- Плановая проверка ---');
    await runCheck();
  }, CONFIG.intervalMs);
}

// Graceful shutdown
process.on('SIGINT', async () => {
  log('Получен SIGINT, завершаю...');
  try { if (browser) await browser.close(); } catch (e) {}
  process.exit(0);
});

process.on('uncaughtException', async (e) => {
  log('UNCAUGHT EXCEPTION:', e.stack);
  try {
    await tgSend(`💥 Критическая ошибка бота:\n<code>${e.message}</code>\nПерезапусти процесс.`);
  } catch (te) {}
});

main().catch(async (e) => {
  log('FATAL:', e.stack);
  try { await tgSend(`💥 Бот не смог запуститься:\n${e.message}`); } catch (te) {}
  process.exit(1);
});
