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
  return {
    known: {}, lastCount: null, firstRun: true,
    maxRent: C.maxRent, minRooms: C.minRooms,
    tgOffset: 0,
  };
}
function saveState(s) { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); }
let STATE = loadState();

let CURRENT = {
  maxRent:  STATE.maxRent  != null ? STATE.maxRent  : C.maxRent,
  minRooms: STATE.minRooms != null ? STATE.minRooms : C.minRooms,
};

// ================================================================
//  TELEGRAM — отправка
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
//  TELEGRAM — приём команд (long polling)
// ================================================================
async function tgGetUpdates(offset) {
  try {
    const resp = await axios.get(`${TG}/getUpdates`, {
      params: { offset, timeout: 25 },
      timeout: 30000,
    });
    return resp.data.result || [];
  } catch (e) {
    log('TG getUpdates error:', e.message);
    return [];
  }
}

function helpText() {
  return [
    '🤖 <b>Команды бота:</b>',
    '',
    '/start — приветствие и текущие настройки',
    '/status — сколько квартир сейчас по фильтру',
    '/rooms N — минимум комнат (например: /rooms 2)',
    '/rent N — максимальная Kaltmiete € (например: /rent 700)',
    '/help — это сообщение',
    '',
    `📊 Сейчас: до <b>${CURRENT.maxRent} €</b>, от <b>${CURRENT.minRooms}</b> комнат`,
  ].join('\n');
}

async function handleCommand(text, chatId) {
  const isOwner = String(chatId) === String(C.tgChatId);

  if (text === '/start') {
    await tgText(`👋 Привет! Я мониторю квартиры на inberlinwohnen.de.\n\n${helpText()}`, { chat_id: chatId });
    return;
  }

  if (text === '/help') {
    await tgText(helpText(), { chat_id: chatId });
    return;
  }

  if (text === '/status') {
    const count = STATE.lastCount != null ? STATE.lastCount : '—';
    await tgText(
      `📊 По текущему фильтру (до ${CURRENT.maxRent} €, от ${CURRENT.minRooms} комнат): <b>${count} квартир</b>`,
      { chat_id: chatId }
    );
    return;
  }

  const roomsMatch = text.match(/^\/rooms\s+(\d+)/);
  if (roomsMatch) {
    if (!isOwner) { await tgText('⛔ Эта команда доступна только владельцу бота.', { chat_id: chatId }); return; }
    CURRENT.minRooms = parseInt(roomsMatch[1], 10);
    STATE.minRooms = CURRENT.minRooms;
    saveState(STATE);
    await tgText(`✅ Минимум комнат изменён на <b>${CURRENT.minRooms}</b>. Применится при следующей проверке.`, { chat_id: chatId });
    return;
  }

  const rentMatch = text.match(/^\/rent\s+(\d+)/);
  if (rentMatch) {
    if (!isOwner) { await tgText('⛔ Эта команда доступна только владельцу бота.', { chat_id: chatId }); return; }
    CURRENT.maxRent = parseInt(rentMatch[1], 10);
    STATE.maxRent = CURRENT.maxRent;
    saveState(STATE);
    await tgText(`✅ Максимальная Kaltmiete изменена на <b>${CURRENT.maxRent} €</b>. Применится при следующей проверке.`, { chat_id: chatId });
    return;
  }

  if (text.startsWith('/')) {
    await tgText('Не знаю такой команды. Напиши /help', { chat_id: chatId });
  }
}

async function pollTelegramOnce() {
  const updates = await tgGetUpdates(STATE.tgOffset || 0);
  for (const u of updates) {
    STATE.tgOffset = u.update_id + 1;
    const msg = u.message;
    if (!msg || !msg.text) continue;
    log('TG входящее:', msg.chat.id, msg.text);
    await handleCommand(msg.text.trim(), msg.chat.id).catch(e => log('handleCommand error:', e.message));
  }
  if (updates.length > 0) saveState(STATE);
}

async function startTelegramPolling() {
  while (true) {
    await pollTelegramOnce().catch(e => log('poll error:', e.message));
    await sleep(2000);
  }
}

// ================================================================
//  СООБЩЕНИЯ О КВАРТИРАХ
// ================================================================
function str(v) {
  if (!v) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function msgNew(apt) {
  const addr     = str(apt.address);
  const district = str(apt.district);
  const title    = str(apt.title);
  const company  = str(apt.company);
  const wbs      = str(apt.wbs);
  const lines = [
    '🏠 <b>Новая квартира!</b>',
    '',
    title    ? `<b>${title}</b>`                    : null,
    addr     ? `📍 ${addr}`                         : null,
    district ? `🗺 Район: ${district}`              : null,
    apt.rooms? `🛏 Комнат: <b>${apt.rooms}</b>`     : null,
    apt.size ? `📐 Площадь: <b>${apt.size} м²</b>` : null,
    apt.rent ? `💶 Kaltmiete: <b>${apt.rent} €</b>`: null,
    company  ? `🏢 ${company}`                      : null,
    wbs      ? `🔑 ${wbs}`                         : null,
  ].filter(Boolean).join('\n');
  return { text: lines, markup: ibwBtn(apt.url) };
}

function msgGone(apt) {
  return [
    '❌ <b>Квартира снята с публикации</b>',
    '',
    apt.title   ? apt.title               : null,
    apt.address ? `📍 ${apt.address}`     : null,
    apt.rooms   ? `🛏 ${apt.rooms} комн.` : null,
    apt.size    ? `📐 ${apt.size} м²`    : null,
    apt.rent    ? `💶 ${apt.rent} €`     : null,
    `🔗 ${apt.url}`,
  ].filter(Boolean).join('\n');
}

// ================================================================
//  SAFE GOTO
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
//  БРАУЗЕР
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
//  АВТОРИЗАЦИЯ
// ================================================================
async function doLogin() {
  log('Авторизация...');

  const resp = await safeGoto(page, C.loginUrl);
  if (!resp) throw new Error('Страница логина недоступна');

  await page.waitForTimeout(2000);

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
    await safeGoto(page, C.finderUrl);
    await page.waitForTimeout(2000);
  }
}

// ================================================================
//  ПАРСИНГ — все страницы, дедупликация на лету по URL
// ================================================================
async function scrapeAll() {
  log('Парсю квартиры...');

  const all = [];
  const seenUrls = new Set();
  let pageNum = 1;

  while (true) {
    log(`Страница ${pageNum}...`);
    const items = await parseCurrentPage();

    let newOnPage = 0;
    for (const a of items) {
      const key = a.url;
      if (!key) continue;
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      all.push(a);
      newOnPage++;
    }

    log(`Страница ${pageNum}: ${items.length} найдено, ${newOnPage} новых уникальных`);

    const hasNext = await goToNextPage(page, pageNum);
    if (!hasNext) {
      log(`Пагинация закончилась. Итого уникальных: ${all.length}`);
      break;
    }
    pageNum++;
    if (pageNum > 10) break;
  }

  return all;
}

async function goToNextPage(page, currentPageNum) {
  const nextNum = currentPageNum + 1;

  const allClickable = await page.locator('a, button, span, li').all();
  const elInfo = [];

  for (const el of allClickable) {
    try {
      const t = (await el.innerText().catch(() => '')).trim();
      if (t && t.length < 30) elInfo.push('"' + t + '"');
    } catch (_) {}
  }
  log('Кликабельные элементы:', elInfo.join(' | ').slice(0, 300));

  for (const el of allClickable) {
    try {
      const t = (await el.innerText().catch(() => '')).trim();
      if (!t) continue;

      const isNext = t === 'Vor' || t === 'Vor >' || t === '>' ||
                     t === '»' || t === String(nextNum);
      if (!isNext) continue;

      const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;

      log('Кнопка следующей страницы найдена: "' + t + '"');
      await el.click();
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000);
      return true;
    } catch (_) {}
  }

  for (const suffix of ['page=' + nextNum, 'p=' + nextNum, 'seite=' + nextNum]) {
    try {
      const el = page.locator('a[href*="' + suffix + '"]').first();
      if (await el.isVisible({ timeout: 500 })) {
        log('Кнопка по href найдена: ' + suffix);
        await el.click();
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);
        return true;
      }
    } catch (_) {}
  }

  log('Кнопка следующей страницы НЕ найдена.');
  return false;
}

// ================================================================
//  ПАРСИНГ ОДНОЙ СТРАНИЦЫ
// ================================================================
async function parseCurrentPage() {
  const result = [];

  const ssPath = path.join(C.outDir, 'results.png');
  if (!fs.existsSync(ssPath)) {
    await page.screenshot({ path: ssPath, fullPage: false });
  }

  const rows = await page.locator('li, tr, [class*="result"], [class*="item"], [class*="expose"]').all();

  for (const row of rows) {
    try {
      const text = (await row.innerText().catch(() => '')).trim();
      if (text.includes('OpenStreetMap') || text.includes('Startseite') || text.includes('Account')) continue;
      if (!text.includes('Zimmer') || !text.includes('€')) continue;
      if (text.length < 15) continue;

      const apt = parseAptText(text);
      if (!apt) continue;

      const foundUrl = await findLink(row);
      if (!foundUrl || foundUrl === C.finderUrl) continue;

      apt.url = foundUrl;
      apt.id  = foundUrl;

      if (passesFilter(apt)) result.push(apt);
    } catch (_) {}
  }

  if (result.length === 0) {
    log('Rows пустые, парсю через ссылки...');
    return parseViaLinks();
  }

  return result;
}

// ================================================================
//  ПАРСИНГ ТЕКСТА КАРТОЧКИ
// ================================================================
function parseAptText(text) {
  const roomsMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:1\/2-)?Zimmer/i);
  const rooms = roomsMatch ? toFloat(roomsMatch[1]) : null;

  const sizeMatch = text.match(/(\d+(?:[,.]?\d+)?)\s*m²/i);
  const size = sizeMatch ? toFloat(sizeMatch[1]) : null;

  const rentMatch = text.match(/\b(\d{3,4}(?:[,.]\d{1,2})?)\s*€/);
  const rent = rentMatch ? toFloat(rentMatch[1]) : null;

  let address = '';
  let district = '';
  const pipeIdx = text.indexOf('|');
  if (pipeIdx !== -1) {
    const raw = text.slice(pipeIdx + 1).trim().split('\n')[0].trim();
    address = raw;
    const plzMatch = raw.match(/\d{5}\s+(.+)/);
    if (plzMatch) district = plzMatch[1].trim();
  } else {
    address  = extractAddress(text);
    district = extractDistrict(text);
  }

  if (!rooms && !rent) return null;

  return {
    id: '', url: '',
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
      if (fullUrl === C.finderUrl) continue;
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
      apt.url = fullUrl;
      apt.id  = fullUrl;

      if (passesFilter(apt)) result.push(apt);
    } catch (_) {}
  }

  return result;
}

// ================================================================
//  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
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
  if (rent  > 0 && rent  > CURRENT.maxRent)  return false;
  if (rooms > 0 && rooms < CURRENT.minRooms) return false;
  return true;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ================================================================
//  ГЛАВНЫЙ ЦИКЛ ПРОВЕРКИ КВАРТИР
// ================================================================
let errCount = 0;

async function runCheck() {
  try {
    await ensureBrowser();
    await ensureLoggedIn();

    const ssPath = path.join(C.outDir, 'results.png');
    if (fs.existsSync(ssPath)) fs.unlinkSync(ssPath);

    const apartments = await scrapeAll();

    apartments.slice(0, 3).forEach((a, i) =>
      log(`[${i}] rooms=${a.rooms} rent=${a.rent}€ size=${a.size}m² | ${a.address} | ${a.url.slice(0, 60)}`)
    );

    const prevKnown = STATE.known || {};
    const currMap   = {};
    for (const a of apartments) currMap[a.id] = a;

    const added   = apartments.filter(a => !prevKnown[a.id]);
    const removed = Object.values(prevKnown).filter(a => !currMap[a.id]);

    log(`Итого: ${apartments.length} | Новых: ${added.length} | Ушло: ${removed.length}`);

    if (STATE.firstRun) {
      STATE.firstRun = false;
      await tgText(
        `🤖 <b>Бот запущен!</b>\n\n` +
        `🔍 Мониторю inberlinwohnen.de\n` +
        `💶 Kaltmiete до ${CURRENT.maxRent} €\n` +
        `🛏 Комнат от ${CURRENT.minRooms}\n` +
        `⏱ Каждые ${C.intervalMs / 60000} мин\n\n` +
        `📊 Сейчас по фильтру: <b>${apartments.length} квартир</b>\n\n` +
        `Команды: /help`
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

    await resetSession();

    if (errCount % 3 === 0) {
      try { if (browser) await browser.close(); } catch (_) {}
      browser = null;
    }
  }
}

// ================================================================
//  СТАРТ
// ================================================================
async function checkLoop() {
  while (true) {
    await runCheck();
    log(`Жду ${C.intervalMs / 60000} мин до следующей проверки...`);
    await sleep(C.intervalMs);
  }
}

async function main() {
  checkConfig();
  log('=== Бот inberlinwohnen.de ===');

  startTelegramPolling();
  await checkLoop();
}

process.on('SIGINT',  async () => { log('SIGINT');  try { await browser?.close(); } catch (_) {} process.exit(0); });
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
