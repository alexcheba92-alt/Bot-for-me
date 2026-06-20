'use strict';

const { C, TIMEOUTS } = require('../config/config');
const log = require('../utils/logger');
const { safeGoto, getPage, getLoggedIn, setLoggedIn } = require('./browser');

async function doLogin() {
  const page = getPage();
  log.info('Авторизация...');

  const resp = await safeGoto(page, C.loginUrl);
  if (!resp) throw new Error('Страница логина недоступна');

  await page.waitForTimeout(2000);

  for (const s of ['text="Alle akzeptieren"', 'text="Speichern"', 'text="Akzeptieren"']) {
    try {
      const btn = page.locator(s).first();
      if (await btn.isVisible({ timeout: TIMEOUTS.COOKIE_POPUP })) {
        await btn.click();
        log.info('Cookie попап закрыт');
        await page.waitForTimeout(1000);
        break;
      }
    } catch (_) {}
  }

  await page.locator('input[type="email"]').first().waitFor({ state: 'visible', timeout: TIMEOUTS.LOGIN_FIELD_WAIT });

  // pressSequentially — печатает по символу, обходит защиту Livewire от мгновенного fill()
  await page.locator('input[type="email"]').first().click();
  await page.locator('input[type="email"]').first().pressSequentially(C.email, { delay: 80 });
  log.info('Email введён');

  await page.locator('input[type="password"]').first().click();
  await page.locator('input[type="password"]').first().pressSequentially(C.password, { delay: 80 });
  log.info('Пароль введён');

  await page.locator('button[type="submit"]').first().click();
  log.info('Log in нажат');

  await page.waitForTimeout(TIMEOUTS.AFTER_LOGIN_SUBMIT);
  await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE }).catch(() => {});

  const url = page.url();
  log.info('URL после логина:', url);

  if (url.includes('/login')) {
    const body = await page.locator('body').innerText().catch(() => '');
    if (body.includes('überprüfen') || body.includes('ungültig') || body.includes('falsch')) {
      throw new Error('Неверный email или пароль');
    }
    try {
      await page.waitForURL(u => !u.includes('/login'), { timeout: 10000 });
    } catch (_) {
      log.info('Livewire — нет редиректа, считаем залогиненным');
    }
  }

  log.info('✅ Авторизован:', page.url());
  setLoggedIn(true);
}

// Проверяет что сессия реально жива — не только по URL, но и по содержимому страницы
async function ensureLoggedIn() {
  const page = getPage();

  if (getLoggedIn()) {
    const resp = await safeGoto(page, C.finderUrl);
    if (!resp) {
      setLoggedIn(false);
    } else {
      const url = page.url();
      if (url.includes('/login')) {
        log.warn('Сессия истекла (редирект на /login), перелогиниваюсь...');
        setLoggedIn(false);
      } else {
        await page.waitForTimeout(1500);
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const looksValid = bodyText.length > 200 &&
          (bodyText.includes('Zimmer') || bodyText.includes('Wohnungsfinder') ||
           bodyText.includes('Wohnungssuche') || bodyText.includes('Angebote') ||
           bodyText.includes('Mein inberlinwohnen'));
        if (!looksValid) {
          log.warn(`Страница finder выглядит подозрительно (длина текста: ${bodyText.length}) — перелогиниваюсь`);
          setLoggedIn(false);
        }
      }
    }
  }

  if (!getLoggedIn()) {
    await doLogin();
    await safeGoto(page, C.finderUrl);
    await page.waitForTimeout(2000);
  }
}

module.exports = { doLogin, ensureLoggedIn };
