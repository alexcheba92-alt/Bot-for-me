'use strict';

const { chromium } = require('playwright');
const { TIMEOUTS }  = require('../config/config');
const log = require('../utils/logger');

let browser  = null;
let ctx      = null;
let page     = null;
let loggedIn = false;
let browserStartedAt = null;

async function ensureBrowser() {
  // Раз в сутки — полный рестарт даже если живой (накопление памяти Chromium)
  if (browser && browserStartedAt && (Date.now() - browserStartedAt > TIMEOUTS.BROWSER_MAX_AGE)) {
    log.info('Браузеру больше 24 часов — плановый перезапуск для очистки памяти');
    try { await browser.close(); } catch (_) {}
    browser = null; ctx = null; page = null; loggedIn = false;
  }

  // Защита от "Target page, context or browser has been closed"
  if (page && page.isClosed()) {
    log.warn('Страница оказалась закрыта (вероятно краш Chromium) — сбрасываю сессию');
    ctx = null; page = null; loggedIn = false;
  }
  if (browser && !browser.isConnected()) {
    log.warn('Браузер отключён (вероятно краш) — сбрасываю всё');
    browser = null; ctx = null; page = null; loggedIn = false;
  }

  if (!browser || !browser.isConnected()) {
    log.info('Запускаю браузер...');
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
    page.setDefaultTimeout(TIMEOUTS.PAGE_LOAD);
    loggedIn = false;
  }
  return { browser, ctx, page };
}

async function resetSession() {
  log.warn('Сбрасываю сессию...');
  try { if (ctx) await ctx.close(); } catch (_) {}
  ctx = null; page = null; loggedIn = false;
}

async function closeBrowser() {
  try { if (browser) await browser.close(); } catch (_) {}
  browser = null; ctx = null; page = null; loggedIn = false;
}

// Обёртка — если Chromium умер посреди операции, сразу сбрасываем сессию
async function safeAction(fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('Target page') || msg.includes('has been closed') ||
        msg.includes('Target closed') || msg.includes('Browser has been closed')) {
      log.error('Обнаружен краш браузера посреди операции — сбрасываю сессию:', msg.slice(0, 100));
      await resetSession();
    }
    throw e;
  }
}

async function safeGoto(targetPage, url, retries = TIMEOUTS.GOTO_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await targetPage.goto(url, { waitUntil: 'commit', timeout: TIMEOUTS.PAGE_LOAD_LOGIN });
    } catch (e) {
      log.warn(`GOTO ERROR (попытка ${attempt + 1}/${retries + 1}):`, url, e.message);
      if (attempt < retries) await new Promise(r => setTimeout(r, TIMEOUTS.GOTO_RETRY_DELAY));
    }
  }
  return null;
}

function getLoggedIn()        { return loggedIn; }
function setLoggedIn(value)   { loggedIn = value; }
function getPage()            { return page; }

module.exports = {
  ensureBrowser, resetSession, closeBrowser, safeAction, safeGoto,
  getLoggedIn, setLoggedIn, getPage,
};
