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
  extraSubscribers: (process.env.TELEGRAM_SUBSCRIBERS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  maxRent:   600,
  minRooms:  3,

  intervalMs: 5 * 60 * 1000,

  loginUrl:   'https://www.inberlinwohnen.de/login',
  finderUrl:  'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder',
  baseUrl:    'https://www.inberlinwohnen.de',
  outDir:     path.join(__dirname, 'out'),
};

if (!fs.existsSync(C.outDir)) fs.mkdirSync(C.outDir, { recursive: true });

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
    subscribers: [],
  };
}
// Все вызовы saveState идут через очередь — это защищает от гонки,
// когда checkLoop() и pollTelegramOnce() пишут state.json одновременно
let saveQueue = Promise.resolve();
function saveState(s) {
  saveQueue = saveQueue.then(() => {
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, stateFile);
  }).catch(e => log('saveState error:', e.message));
  return saveQueue;
}
let STATE = loadState();

function getAllRecipients() {
  const ids = new Set();
  ids.add(String(C.tgChatId));
  for (const id of C.extraSubscribers) ids.add(String(id));
  for (const id of (STATE.subscribers || [])) ids.add(String(id));
  return Array.from(ids);
}

let CURRENT = {
  maxRent:  STATE.maxRent  != null ? STATE.maxRent  : C.maxRent,
  minRooms: STATE.minRooms != null ? STATE.minRooms : C.minRooms,
};

// ================================================================
//  TELEGRAM — отправка (chat_id всегда явный, дефолт владельца)
// ================================================================
const TG = `https://api.telegram.org/bot${C.tgToken}`;

// Универсальная отправка POST в Telegram с обработкой 429 (Too Many Requests).
// Если Telegram просит подождать (retry_after), ждём и пробуем снова.
async function tgPostWithRetry(url, payload, opts = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios.post(url, payload, opts);
    } catch (e) {
      const status = e.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfter = e.response?.data?.parameters?.retry_after || 3;
        log(`TG 429 Flood control — жду ${retryAfter} сек (попытка ${attempt + 1}/${maxRetries})`);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      throw e;
    }
  }
}

async function tgText(text, extra = {}) {
  try {
    await tgPostWithRetry(`${TG}/sendMessage`, {
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      chat_id: C.tgChatId,
      ...extra,
    }, { timeout: 15000 });
  } catch (e) { log('TG error:', e.message); }
}

async function tgPhoto(filePath, caption = '', chatId = C.tgChatId) {
  try {
    const form = new FormData();
    form.append('chat_id',    chatId);
    form.append('photo',      fs.createReadStream(filePath));
    form.append('caption',    caption.slice(0, 1024));
    form.append('parse_mode', 'HTML');
    await tgPostWithRetry(`${TG}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 30000 });
  } catch (e) { log('TG photo error:', e.message); }
}

function ibwBtn(url) {
  return { inline_keyboard: [[{ text: '🔗 Открыть на inberlinwohnen.de', url }]] };
}

async function broadcastText(text, extra = {}) {
  for (const chatId of getAllRecipients()) {
    try {
      await tgPostWithRetry(`${TG}/sendMessage`, {
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        chat_id: chatId,
        ...extra,
      }, { timeout: 15000 });
    } catch (e) { log('TG broadcast error for', chatId, ':', e.message); }
    await sleep(150);
  }
}

async function broadcastPhoto(filePath, caption = '') {
  for (const chatId of getAllRecipients()) {
    await tgPhoto(filePath, caption, chatId);
    await sleep(150);
  }
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
    '/subscribe — получать уведомления о новых квартирах',
    '/unsubscribe — отписаться от уведомлений',
    '/rooms N — минимум комнат (только владелец)',
    '/rent N — максимальная Kaltmiete € (только владелец)',
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
    await tgText(`✅ Минимум комнат изменён на <b>${CURRENT.minRooms}</b>.`, { chat_id: chatId });
    return;
  }

  const rentMatch = text.match(/^\/rent\s+(\d+)/);
  if (rentMatch) {
    if (!isOwner) { await tgText('⛔ Эта команда доступна только владельцу бота.', { chat_id: chatId }); return; }
    CURRENT.maxRent = parseInt(rentMatch[1], 10);
    STATE.maxRent = CURRENT.maxRent;
    saveState(STATE);
    await tgText(`✅ Максимальная Kaltmiete изменена на <b>${CURRENT.maxRent} €</b>.`, { chat_id: chatId });
    return;
  }

  if (text === '/subscribe') {
    const id = String(chatId);
    if (!STATE.subscribers) STATE.subscribers = [];
    if (STATE.subscribers.includes(id) || id === String(C.tgChatId)) {
      await tgText('✅ Ты уже подписан на уведомления.', { chat_id: chatId });
    } else {
      STATE.subscribers.push(id);
      saveState(STATE);
      await tgText('✅ Подписка оформлена!', { chat_id: chatId });
      log('Новый подписчик:', id);
    }
    return;
  }

  if (text === '/unsubscribe') {
    const id = String(chatId);
    STATE.subscribers = (STATE.subscribers || []).filter(s => s !== id);
    saveState(STATE);
    await tgText('Отписка выполнена.', { chat_id: chatId });
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
  let consecutiveErrors = 0;
  const backoffSteps = [2000, 4000, 8000, 16000, 30000]; // 2s → 30s максимум

  while (true) {
    try {
      await pollTelegramOnce();
      consecutiveErrors = 0;
      await sleep(2000);
    } catch (e) {
      consecutiveErrors++;
      const delay = backoffSteps[Math.min(consecutiveErrors - 1, backoffSteps.length - 1)];
      log(`poll error (подряд ${consecutiveErrors}):`, e.message, `— жду ${delay / 1000}с`);
      await sleep(delay);
    }
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
  const company  = str(apt.company);
  const wbs      = str(apt.wbs);
  const lines = [
    '🏠 <b>Новая квартира!</b>',
    '',
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
    apt.address ? `📍 ${apt.address}`     : null,
    apt.rooms   ? `🛏 ${apt.rooms} комн.` : null,
    apt.size    ? `📐 ${apt.size} м²`    : null,
    apt.rent    ? `💶 ${apt.rent} €`     : null,
    apt.url     ? `🔗 ${apt.url}`        : null,
  ].filter(Boolean).join('\n');
}

// ================================================================
//  SAFE GOTO
// ================================================================
async function safeGoto(page, url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
      return resp;
    } catch (e) {
      log(`GOTO ERROR (попытка ${attempt + 1}/${retries + 1}):`, url, e.message);
      if (attempt < retries) await sleep(2000);
    }
  }
  return null;
}

// ================================================================
//  БРАУЗЕР
// ================================================================
let browser  = null;
let ctx      = null;
let page     = null;
let loggedIn = false;
let browserStartedAt = null;
const BROWSER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 часа

async function ensureBrowser() {
  // Раз в сутки — полный рестарт браузера, даже если он живой.
  // Playwright/Chromium может накапливать память за недели работы.
  if (browser && browserStartedAt && (Date.now() - browserStartedAt > BROWSER_MAX_AGE_MS)) {
    log('Браузеру больше 24 часов — плановый перезапуск для очистки памяти');
    try { await browser.close(); } catch (_) {}
    browser = null; ctx = null; page = null; loggedIn = false;
  }

  // Защита от "Target page, context or browser has been closed" —
  // Chromium иногда падает сам по себе, страница/контекст остаются
  // в переменных но реально уже не существуют
  if (page && page.isClosed()) {
    log('Страница оказалась закрыта (вероятно краш Chromium) — сбрасываю сессию');
    ctx = null; page = null; loggedIn = false;
  }
  if (browser && !browser.isConnected()) {
    log('Браузер отключён (вероятно краш) — сбрасываю всё');
    browser = null; ctx = null; page = null; loggedIn = false;
  }

  if (!browser || !browser.isConnected()) {
    log('Запускаю браузер...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    browserStartedAt = Date.now();
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
        log('Сессия истекла (редирект на /login), перелогиниваюсь...');
        loggedIn = false;
      } else {
        // Дополнительная проверка: страница должна реально содержать
        // что-то похожее на форму поиска или результаты, а не быть пустой
        // или страницей ошибки без редиректа на /login
        await page.waitForTimeout(1500);
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const looksValid = bodyText.length > 200 &&
          (bodyText.includes('Zimmer') || bodyText.includes('Wohnungsfinder') ||
           bodyText.includes('Wohnungssuche') || bodyText.includes('Angebote') ||
           bodyText.includes('Mein inberlinwohnen'));
        if (!looksValid) {
          log(`Страница finder выглядит подозрительно (длина текста: ${bodyText.length}) — перелогиниваюсь на всякий случай`);
          loggedIn = false;
        }
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
//  МУСОРНЫЕ URL — то что точно не квартира
// ================================================================
function isJunkUrl(url) {
  if (!url) return true;
  if (url === C.baseUrl || url === C.baseUrl + '/') return true;
  if (url === C.finderUrl) return true;
  if (url.endsWith('/mein-bereich') || url.endsWith('/mein-bereich/')) return true;

  const junkPaths = ['/support', '/account', '/profil', '/sicherheit', '/datenschutz',
                     '/impressum', '/kontakt', '/startseite', '/tauschportal',
                     '/login', '/logout', '/agb'];
  for (const j of junkPaths) {
    if (url.includes(j)) return true;
  }
  return false;
}

// Положительный признак реальной квартиры — точный паттерн объявлений HOWOGE и т.п.
function isApartmentUrl(url) {
  if (!url) return false;
  if (isJunkUrl(url)) return false;
  // Известный паттерн: /wohnungssuche/detail/1770-20506-16.html
  if (/\/detail\/[\w-]+/i.test(url)) return true;
  // Запасной паттерн 1: путь содержит /wohnungssuche/ — каталог реальных объявлений,
  // надёжнее искать так на случай если сайт уберёт /detail/ из структуры
  if (/\/wohnungssuche\//i.test(url)) return true;
  // Запасной паттерн 2: длинный числовой ID в пути
  if (/\d{4,}/.test(url) && (/expose|objekt|wohnung|apartment/i.test(url))) return true;
  return false;
}

// ================================================================
//  ПАРСИНГ — все страницы, дедупликация на лету по URL
// ================================================================
async function scrapeAll() {
  log('Парсю квартиры...');

  const all = [];
  const seenUrls = new Set();
  let pageNum = 1;
  let lastPageSignature = null;

  while (true) {
    log(`Страница ${pageNum}...`);

    const items = await parseCurrentPage();

    // Подпись страницы — URL + отсортированный список найденных квартирных ссылок.
    // Надёжнее чем текст body: меню сайта одинаковое на всех страницах,
    // а вот набор реальных квартир должен отличаться.
    const currentUrl = page.url();
    const urlsOnPage = items.map(a => a.url).filter(Boolean).sort().join('|');
    const sigShort = currentUrl + '::' + urlsOnPage;

    if (lastPageSignature !== null && sigShort === lastPageSignature) {
      log('Страница идентична предыдущей (тот же URL и тот же набор квартир) — останавливаюсь.');
      break;
    }

    let newOnPage = 0;
    for (const a of items) {
      const key = a.url;
      if (!key || isJunkUrl(key)) continue;
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      all.push(a);
      newOnPage++;
    }

    log(`Страница ${pageNum}: ${items.length} найдено, ${newOnPage} новых уникальных`);
    lastPageSignature = sigShort;

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

// ================================================================
//  ПАГИНАЦИЯ
//  ВАЖНО: "Vor" на этой странице ведёт НАЗАД (проверено в логах) —
//  поэтому "Vor" исключён из критериев следующей страницы.
//  Следующая страница определяется ТОЛЬКО по номеру страницы
//  больше текущего, либо по однозначным символам > / »
// ================================================================
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

  const beforeUrl  = page.url();
  const beforeText = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);

  for (const el of allClickable) {
    try {
      const t = (await el.innerText().catch(() => '')).trim();
      if (!t) continue;

      // СТРОГО: только точный номер следующей страницы или однозначные "вперёд" символы.
      // "Vor" сюда НЕ включаем — экспериментально подтверждено что это "назад".
      const isNext = t === String(nextNum) || t === '>' || t === '»' || t === '>>';
      if (!isNext) continue;

      const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;

      // Доп. проверка: если это номер страницы, убеждаемся что это похоже на
      // пагинацию — есть href с числом, или родитель содержит другие номера
      // страниц рядом (например "1 2 3 Vor"), а не случайная "2" в тексте сайта.
      if (t === String(nextNum)) {
        const href = await el.getAttribute('href').catch(() => null);
        const looksLikePagination = href
          ? /page|seite|p=/i.test(href) || /\d/.test(href)
          : await el.evaluate(node => {
              const parent = node.closest('ul, nav, div');
              if (!parent) return false;
              const siblingText = parent.innerText || '';
              // Похоже на пагинацию если рядом есть другие маленькие числа
              const nums = siblingText.match(/\b\d{1,3}\b/g) || [];
              return nums.length >= 2;
            }).catch(() => false);
        if (!looksLikePagination) {
          log(`Пропускаю "${t}" — не похоже на кнопку пагинации (нет признаков рядом)`);
          continue;
        }
      }

      log('Кнопка следующей страницы найдена: "' + t + '"');
      await el.click();
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000);

      const afterUrl  = page.url();
      const afterText = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);
      log('URL до/после:', beforeUrl, '→', afterUrl);

      if (beforeUrl === afterUrl && beforeText === afterText) {
        log('Пагинация не сработала — содержимое не изменилось');
        return false;
      }
      return true;
    } catch (_) {}
  }

  // По href с номером страницы
  for (const suffix of ['page=' + nextNum, 'p=' + nextNum, 'seite=' + nextNum]) {
    try {
      const el = page.locator('a[href*="' + suffix + '"]').first();
      if (await el.isVisible({ timeout: 500 })) {
        log('Кнопка по href найдена: ' + suffix);
        await el.click();
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);
        if (page.url() === beforeUrl) {
          log('Пагинация по href не сработала');
          return false;
        }
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
  // Обновляем скриншот раз в сутки, а не один раз навсегда —
  // если сайт изменит вёрстку, мы это увидим
  const ssIsStale = !fs.existsSync(ssPath) ||
    (Date.now() - fs.statSync(ssPath).mtimeMs > 24 * 60 * 60 * 1000);
  if (ssIsStale) {
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
      if (isJunkUrl(foundUrl)) continue;

      apt.url = foundUrl;
      apt.id  = foundUrl;

      if (passesFilter(apt)) result.push(apt);
    } catch (_) {}
  }

  // ВАЖНО: НЕ переключаемся на parseViaLinks автоматически если rows просто пусто —
  // это и было причиной мусора (меню, /support, OpenStreetMap).
  // Используем его только как явный, контролируемый fallback с тем же строгим фильтром.
  if (result.length === 0) {
    log('Rows пустые, пробую fallback через ссылки (со строгим фильтром мусора)...');
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
  // Дополнительная защита: если нет ни адреса, ни района — скорее всего мусор
  if (!address && !district) return null;

  return {
    id: '', url: '',
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

    // Приоритет 1: точный паттерн /detail/ID — это формат реальных объявлений
    // (например HOWOGE: /wohnungssuche/detail/1770-20506-16.html)
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      const full = href.startsWith('http') ? href : C.baseUrl + href;
      if (isJunkUrl(full)) continue;
      if (/\/detail\/[\w-]+/i.test(href)) return full;
    }

    // Приоритет 1.5: запасной — каталог /wohnungssuche/ без /detail/
    // (на случай изменения структуры URL сайтом)
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      const full = href.startsWith('http') ? href : C.baseUrl + href;
      if (isJunkUrl(full)) continue;
      if (/\/wohnungssuche\//i.test(href)) return full;
    }

    // Приоритет 2: запасные паттерны (длинное число + ключевое слово)
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      const full = href.startsWith('http') ? href : C.baseUrl + href;
      if (isJunkUrl(full)) continue;
      if (href.match(/\d{4,}/) || /expose|objekt|wohnung|apartment/i.test(href)) {
        return full;
      }
    }

    // Приоритет 3: любая непустая не-мусорная ссылка
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#' || href.startsWith('mailto') || href.startsWith('tel')) continue;
      const full = href.startsWith('http') ? href : C.baseUrl + href;
      if (isJunkUrl(full)) continue;
      return full;
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
      if (isJunkUrl(fullUrl)) continue;
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
      if (parentText.includes('OpenStreetMap')) continue;

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
//  ОСНОВНАЯ ПРОВЕРКА (внутренняя, без таймаута)
// ================================================================
let errCount = 0;

async function runCheckInternal() {
  await ensureBrowser();
  await ensureLoggedIn();

  // Скриншот теперь обновляется автоматически раз в сутки (см. parseCurrentPage),
  // принудительное удаление здесь больше не нужно
  const apartments = await scrapeAll();

  // ═══════════════════════════════════════════════════════════════
  // КРИТИЧЕСКАЯ ЗАЩИТА: если нашли 0 квартир, а до этого было
  // разумное количество — это почти наверняка сбой парсинга
  // (сессия истекла молча, сайт отдал пустую страницу, верстка
  // изменилась), А НЕ реальное исчезновение всех объявлений сразу.
  // Без этой защиты бот разослал бы "все квартиры пропали".
  // ═══════════════════════════════════════════════════════════════
  const prevCount = STATE.lastCount || 0;
  if (apartments.length === 0 && prevCount >= 3) {
    log(`⚠️ ПОДОЗРИТЕЛЬНО: нашли 0 квартир, хотя в прошлый раз было ${prevCount}. ` +
        `Похоже на сбой парсинга, а не реальное исчезновение. Пропускаю уведомления, ` +
        `форсирую релогин на следующей попытке.`);
    await tgText(
      `⚠️ Подозрительный результат: 0 квартир найдено (было ${prevCount}).\n` +
      `Похоже на сбой сканирования, а не реальное изменение на сайте.\n` +
      `Уведомления о пропавших квартирах пропущены, пробую снова через 5 минут.`
    ).catch(() => {});
    // Форсируем релогин на следующей попытке — возможно сессия молча умерла
    loggedIn = false;
    // НЕ обновляем STATE.known и STATE.lastCount — следующая успешная
    // проверка сравнится с последним ВАЛИДНЫМ состоянием, а не с нулём
    return;
  }

  apartments.slice(0, 5).forEach((a, i) =>
    log(`[${i}] rooms=${a.rooms} rent=${a.rent}€ size=${a.size}m² | ${a.address} | ${a.url.slice(0, 70)}`)
  );

  const prevKnown = STATE.known || {};
  const currMap   = {};
  // Храним КОМПАКТНУЮ версию объекта — не всё что есть, чтобы state.json не разрастался
  for (const a of apartments) {
    currMap[a.id] = {
      address: a.address, district: a.district,
      rooms: a.rooms, rent: a.rent, size: a.size, url: a.url,
    };
  }

  const added   = apartments.filter(a => !prevKnown[a.id]);
  const removed = Object.entries(prevKnown)
    .filter(([id]) => !currMap[id])
    .map(([id, data]) => ({ ...data, id }));

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
    if (fs.existsSync(ssPath2)) await broadcastPhoto(ssPath2, `Страница поиска (${apartments.length} квартир)`);
  }

  for (const apt of added) {
    log('НОВАЯ:', apt.id);
    const { text, markup } = msgNew(apt);
    await broadcastText(text, { reply_markup: markup });
    // Сохраняем СРАЗУ после отправки — если упадём на следующей квартире,
    // эта уже не будет отправлена повторно при перезапуске
    currMap[apt.id] = {
      address: apt.address, district: apt.district,
      rooms: apt.rooms, rent: apt.rent, size: apt.size, url: apt.url,
    };
    STATE.known = currMap;
    saveState(STATE);
  }

  for (const apt of removed) {
    log('УШЛА:', apt.id);
    await broadcastText(msgGone(apt));
    // Аналогично — убираем из known сразу после уведомления
    delete currMap[apt.id];
    STATE.known = currMap;
    saveState(STATE);
  }

  // Примечание: блок "количество изменилось без added/removed" убран —
  // такая ситуация практически невозможна, т.к. если число квартир
  // меняется, у нас почти всегда есть конкретные added или removed.

  STATE.known     = currMap;
  STATE.lastCount = apartments.length;
  saveState(STATE);
  errCount = 0;
}

// ================================================================
//  ОБЁРТКА С ГЛОБАЛЬНЫМ ТАЙМАУТОМ
//  Если проверка зависнет дольше 2 минут — прерываем и сбрасываем сессию,
//  не висим вечно
// ================================================================
async function runCheck() {
  let timeoutHandle;
  try {
    await Promise.race([
      runCheckInternal(),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Проверка зависла дольше 2 минут')), 120000);
      }),
    ]);
  } catch (e) {
    errCount++;
    log('ОШИБКА:', e.message);
    await tgText(`⚠️ Ошибка #${errCount}:\n<code>${e.message}</code>`).catch(() => {});

    await resetSession();
    if (errCount % 3 === 0) {
      try { if (browser) await browser.close(); } catch (_) {}
      browser = null;
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ================================================================
//  СТАРТ
// ================================================================
let isChecking = false;

async function checkLoop() {
  while (true) {
    if (isChecking) {
      log('⚠️ Предыдущая проверка ещё идёт — пропускаю цикл (защита от параллельных запусков)');
      await sleep(5000);
      continue;
    }
    isChecking = true;
    try {
      await runCheck();
    } finally {
      isChecking = false;
    }
    log(`Жду ${C.intervalMs / 60000} мин до следующей проверки...`);
    await sleep(C.intervalMs);
  }
}

// ================================================================
//  LOCK-ФАЙЛ — защита от двойного запуска
//  Если процесс уже работает, новый экземпляр не стартует
//  и не будет слать дублирующиеся уведомления
// ================================================================
const lockFile = path.join(C.outDir, 'bot.lock');

function acquireLock() {
  if (fs.existsSync(lockFile)) {
    const oldPid = fs.readFileSync(lockFile, 'utf8').trim();
    // Проверяем жив ли процесс со старым PID (актуально для VPS;
    // на Railway процессы переживают рестарт контейнера редко,
    // но проверка не вредит)
    try {
      process.kill(Number(oldPid), 0); // не убивает, просто проверяет существование
      console.error(`❌ Бот уже запущен (PID ${oldPid}). Завершаю, чтобы не дублировать уведомления.`);
      process.exit(1);
    } catch (_) {
      // Процесс с этим PID не существует — старый lock устарел, перезаписываем
      log('Найден устаревший lock-файл (процесс не существует), перезаписываю');
    }
  }
  fs.writeFileSync(lockFile, String(process.pid));
}

function releaseLock() {
  try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch (_) {}
}

async function main() {
  checkConfig();
  acquireLock();
  log('=== Бот inberlinwohnen.de ===');

  startTelegramPolling();
  await checkLoop();
}

process.on('SIGINT',  async () => { log('SIGINT');  releaseLock(); try { await browser?.close(); } catch (_) {} process.exit(0); });
process.on('SIGTERM', async () => { log('SIGTERM'); releaseLock(); try { await browser?.close(); } catch (_) {} process.exit(0); });
process.on('uncaughtException', async (e) => {
  log('UNCAUGHT:', e.stack);
  try { await tgText(`💥 Критическая ошибка:\n<code>${e.message}</code>`); } catch (_) {}
});
process.on('unhandledRejection', async (reason) => {
  log('UNHANDLED REJECTION:', reason instanceof Error ? reason.stack : String(reason));
  try { await tgText(`💥 Необработанная ошибка промиса:\n<code>${String(reason).slice(0, 300)}</code>`); } catch (_) {}
});

main().catch(async e => {
  log('FATAL:', e.stack);
  try { await tgText(`💥 Не запустился:\n${e.message}`); } catch (_) {}
  process.exit(1);
});
