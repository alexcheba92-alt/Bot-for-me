'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ================= CONFIG =================

const CONFIG = {
  login:
    process.env.IBW_LOGIN ||
    process.env.INBERLIN_EMAIL ||
    '',

  password:
    process.env.IBW_PASSWORD ||
    process.env.INBERLIN_PASSWORD ||
    '',

  tgToken: process.env.TELEGRAM_TOKEN || '',
  tgChatId: process.env.TELEGRAM_CHAT_ID || '',

  maxRent: 600,
  rooms: 3,

  intervalMs: 5 * 60 * 1000,

  loginUrl: 'https://www.inberlinwohnen.de/mein-bereich/',
  finderUrl: 'https://www.inberlinwohnen.de/wohnungsfinder/',

  baseUrl: 'https://www.inberlinwohnen.de',
  outDir: path.join(__dirname, 'out'),
};

if (!fs.existsSync(CONFIG.outDir)) {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
}

// ================= LOG =================

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ================= TELEGRAM =================

async function tgSend(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`,
      {
        chat_id: CONFIG.tgChatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }
    );
  } catch (e) {
    log('TG ERROR:', e.message);
  }
}

// ================= HTTP CLIENT =================

const http = axios.create({
  timeout: 60000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  },
});

// ================= LOGIN (COOKIE BASED) =================

let cookies = '';

async function login() {
  log('LOGIN (HTTP)...');

  try {
    const res = await http.get(CONFIG.loginUrl);

    cookies = res.headers['set-cookie']
      ? res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ')
      : '';

    log('Got cookies:', cookies ? 'YES' : 'NO');

  } catch (e) {
    throw new Error('Login request failed: ' + e.message);
  }
}

// ================= FETCH PAGE =================

async function fetchPage(url) {
  const res = await http.get(url, {
    headers: {
      Cookie: cookies,
    },
  });

  return res.data;
}

// ================= PARSE APARTMENTS =================

function parse(html) {
  const list = [];

  const regex =
    /(\d{1,2})\s*Zimmer.*?(\d{2,3}[.,]\d{0,2})\s*m².*?(\d{3,4}[.,]\d{0,2})\s*€/gms;

  let m;

  while ((m = regex.exec(html)) !== null) {
    const rooms = parseFloat(m[1]);
    const size = m[2];
    const rent = parseFloat(m[3].replace(',', '.'));

    if (rent > CONFIG.maxRent) continue;
    if (rooms < CONFIG.rooms) continue;

    list.push({
      id: m[0],
      rooms,
      size,
      rent,
    });
  }

  return list;
}

// ================= RUN =================

let first = true;

async function run() {
  try {
    await login();

    const html = await fetchPage(CONFIG.finderUrl);

    if (!html || html.length < 1000) {
      throw new Error('Empty HTML received (blocked or redirect)');
    }

    const apartments = parse(html);

    log('FOUND:', apartments.length);

    if (first) {
      first = false;
      await tgSend(`🤖 Bot started\nFound: ${apartments.length}`);
      return;
    }

    if (apartments.length === 0) {
      await tgSend('⚠️ No apartments found (maybe site structure changed)');
      return;
    }

    const msg =
      `🏠 Apartments found: ${apartments.length}\n\n` +
      apartments
        .slice(0, 5)
        .map(a => `${a.rooms} rooms | ${a.size} m² | ${a.rent} €`)
        .join('\n');

    await tgSend(msg);

  } catch (e) {
    log('ERROR:', e.message);
    await tgSend(`⚠️ ERROR:\n${e.message}`);
  }
}

// ================= START =================

(async () => {
  log('BOT STARTED (NO BROWSER MODE)');

  if (!CONFIG.login || !CONFIG.password) {
    log('MISSING CREDENTIALS');
    return;
  }

  await run();
  setInterval(run, CONFIG.intervalMs);
})();
