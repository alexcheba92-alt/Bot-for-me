'use strict';

const axios    = require('axios');
const FormData = require('form-data');
const fs       = require('fs');
const { C }    = require('../config/config');
const log      = require('../utils/logger');
const { sleep } = require('../utils/sleep');

const TG = `https://api.telegram.org/bot${C.tgToken}`;

// Универсальная отправка POST в Telegram с обработкой 429 (Flood control)
async function tgPostWithRetry(url, payload, opts = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios.post(url, payload, opts);
    } catch (e) {
      const status = e.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfter = e.response?.data?.parameters?.retry_after || 3;
        log.warn(`TG 429 Flood control — жду ${retryAfter} сек (попытка ${attempt + 1}/${maxRetries})`);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      throw e;
    }
  }
}

async function tgText(chatId, text, extra = {}) {
  try {
    await tgPostWithRetry(`${TG}/sendMessage`, {
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      chat_id: chatId,
      ...extra,
    }, { timeout: 15000 });
    return true;
  } catch (e) {
    log.error('TG sendMessage error для', chatId, ':', e.message);
    return false;
  }
}

async function tgPhoto(chatId, filePath, caption = '') {
  try {
    const form = new FormData();
    form.append('chat_id',    chatId);
    form.append('photo',      fs.createReadStream(filePath));
    form.append('caption',    caption.slice(0, 1024));
    form.append('parse_mode', 'HTML');
    await tgPostWithRetry(`${TG}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 30000 });
    return true;
  } catch (e) {
    log.error('TG sendPhoto error для', chatId, ':', e.message);
    return false;
  }
}

async function tgGetUpdates(offset) {
  try {
    const resp = await axios.get(`${TG}/getUpdates`, {
      params: { offset, timeout: 25 },
      timeout: 30000,
    });
    return resp.data.result || [];
  } catch (e) {
    log.error('TG getUpdates error:', e.message);
    throw e; // пробрасываем, чтобы polling.js сделал backoff
  }
}

function ibwBtn(url) {
  return { inline_keyboard: [[{ text: '🔗 Открыть на inberlinwohnen.de', url }]] };
}

module.exports = { tgText, tgPhoto, tgGetUpdates, ibwBtn, tgPostWithRetry, TG };
