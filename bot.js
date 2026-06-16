'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  login: process.env.INBERLIN_EMAIL || '',
  password: process.env.INBERLIN_PASSWORD || '',
  tgToken: process.env.TELEGRAM_TOKEN || '',
  tgChatId: process.env.TELEGRAM_CHAT_ID || '',
  maxRent: Number(process.env.MAX_RENT || 600),
  rooms: Number(process.env.ROOMS || 3),
  intervalMs: 300000,

  loginUrl: 'https://www.inberlinwohnen.de/',
  finderUrl: 'https://www.inberlinwohnen.de/mein-bereich/wohnungsfinder/',
};

function log(...a) {
  console.log(`[${new Date().toISOString()}]`, ...a);
}

// ---------------- TELEGRAM FIX ----------------
async function tgSend(text) {
  if (!CONFIG.tgToken || !CONFIG.tgChatId) {
    log('TG SKIPPED (missing config)');
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
      chat_id: CONFIG.tgChatId,
      text: String(text).slice(0, 3500),
      parse_mode: 'HTML'
    }, { timeout: 15000 });

  } catch (e) {
    log('TG ERROR:', e.response?.data || e.message);
  }
}

// ---------------- LOGIN ----------------
async function login(page) {
  log('LOGIN...');

  await page.goto(CONFIG.loginUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(4000);

  const email = page.locator('input[type="email"], input[name*="email"], input[name*="user"], input[name*="log"]').first();
  const pass = page.locator('input[type="password"]').first();

  if (await email.isVisible().catch(() => false)) {
    await email.fill(CONFIG.login);
    await pass.fill(CONFIG.password);

    const btn = page.locator('button[type="submit"], input[type="submit"]').first();
    if (await btn.count()) {
      await btn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(5000);
  }

  log('LOGIN DONE →', page.url());
}

// ---------------- SCRAPE REAL DOM ----------------
async function scrape(page) {
  log('OPEN FINDER');

  await page.goto(CONFIG.finderUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(7000);

  const cards = await page.evaluate(() => {
    const items = [];
    const els = document.querySelectorAll('article, li, div');

    for (const el of els) {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();

      if (!text || text.length < 70) continue;

      const hasRooms = /\d+\s*Zimmer/i.test(text);
      const hasPrice = /\d+\s*€/i.test(text);
      const hasSize = /\d+\s*m²/i.test(text);

      if (!hasRooms && !hasPrice && !hasSize) continue;

      const a = el.querySelector('a[href]');
      items.push({
        text,
        href: a ? a.href : ''
      });
    }

    return items;
  });

  return cards.map(c => {
    const r = c.text.match(/(\d+)\s*Zimmer/i);
    const s = c.text.match(/(\d+)\s*m²/i);
    const p = c.text.match(/(\d+)\s*€/i);

    return {
      rooms: r?.[1] || '',
      size: s?.[1] || '',
      rent: p?.[1] || '',
      href: c.href
    };
  });
}

// ---------------- RUN ----------------
async function run() {
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const ctx = await browser.newContext({
      locale: 'de-DE',
      viewport: { width: 1280, height: 800 }
    });

    const page = await ctx.newPage();

    await login(page);

    const list = await scrape(page);

    log('FOUND:', list.length);

    if (!list.length) {
      await tgSend('⚠️ No apartments found (site blocked or changed)');
      return;
    }

    const msg =
      `🏠 <b>Found:</b> ${list.length}\n\n` +
      list.slice(0, 5).map(a =>
        `• ${a.rooms} Zimmer | ${a.size} m² | ${a.rent} €\n${a.href}`
      ).join('\n\n');

    await tgSend(msg);

  } catch (e) {
    log('ERROR:', e.message);
    await tgSend('⚠️ ERROR:\n' + e.message);
  } finally {
    try { await browser?.close(); } catch {}
  }
}

// ---------------- START ----------------
(async () => {
  log('BOT STARTED');

  if (!CONFIG.login || !CONFIG.password) {
    log('MISSING ENV');
    process.exit(1);
  }

  await run();
  setInterval(run, CONFIG.intervalMs);
})();
