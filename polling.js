'use strict';

try { require('dotenv').config(); } catch (_) { /* dotenv не критичен — переменные могут быть заданы средой (Railway) */ }
const path = require('path');

// ================================================================
//  ОСНОВНОЙ КОНФИГ
// ================================================================
const C = {
  email:      process.env.INBERLIN_EMAIL    || '',
  password:   process.env.INBERLIN_PASSWORD || '',
  tgToken:    process.env.TELEGRAM_TOKEN    || '',
  tgChatId:   process.env.TELEGRAM_CHAT_ID  || '',

  // Фильтр владельца по умолчанию (используется и как дефолт для новых подписчиков)
  defaultMaxRent:  600,
  defaultMinRooms: 3,

  intervalMs: 5 * 60 * 1000,

  loginUrl:   'https://www.inberlinwohnen.de/login',
  finderUrl:  'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder',
  baseUrl:    'https://www.inberlinwohnen.de',

  rootDir: path.join(__dirname, '..', '..'),
  outDir:  path.join(__dirname, '..', '..', 'out'),
  dbPath:  path.join(__dirname, '..', '..', 'out', 'bot.db'),
};

// ================================================================
//  ТАЙМАУТЫ — все магические числа собраны здесь
// ================================================================
const TIMEOUTS = {
  LOGIN_FIELD_WAIT:    15000,
  PAGE_LOAD:           30000,
  PAGE_LOAD_LOGIN:     45000,
  NETWORK_IDLE:        20000,
  NETWORK_IDLE_LONG:   25000,
  AFTER_CLICK:         3000,
  AFTER_LOGIN_SUBMIT:  5000,
  COOKIE_POPUP:        2000,
  ELEMENT_VISIBLE:     500,
  PAGINATION_MAX_PAGES: 10,
  GLOBAL_CHECK_TIMEOUT: 180000, // 3 минуты на всю проверку
  BROWSER_MAX_AGE:     24 * 60 * 60 * 1000, // 24 часа
  HEALTH_REPORT_EVERY: 24 * 60 * 60 * 1000, // раз в сутки
  GOTO_RETRIES:        2,
  GOTO_RETRY_DELAY:    2000,
  TG_POLL_INTERVAL:    2000,
  TG_BACKOFF_STEPS:    [2000, 4000, 8000, 16000, 30000],
  BROADCAST_PAUSE:     150,
};

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

module.exports = { C, TIMEOUTS, checkConfig };
