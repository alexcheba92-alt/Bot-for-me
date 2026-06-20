'use strict';

const { TIMEOUTS } = require('../config/config');
const log = require('../utils/logger');

// ВАЖНО: "Vor" на этом сайте ведёт НАЗАД (проверено в логах прошлых
// прогонов) — поэтому "Vor" исключён из критериев следующей страницы.
// Следующая страница определяется только по номеру или однозначным символам.
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
  log.debug('Кликабельные элементы:', elInfo.join(' | ').slice(0, 300));

  const beforeUrl  = page.url();
  const beforeText = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);

  for (const el of allClickable) {
    try {
      const t = (await el.innerText().catch(() => '')).trim();
      if (!t) continue;

      const isNext = t === String(nextNum) || t === '>' || t === '»' || t === '>>';
      if (!isNext) continue;

      const visible = await el.isVisible({ timeout: TIMEOUTS.ELEMENT_VISIBLE }).catch(() => false);
      if (!visible) continue;

      // Доп. проверка для номеров страниц — похоже ли на реальную пагинацию
      if (t === String(nextNum)) {
        const href = await el.getAttribute('href').catch(() => null);
        const looksLikePagination = href
          ? /page|seite|p=/i.test(href) || /\d/.test(href)
          : await el.evaluate(node => {
              const parent = node.closest('ul, nav, div');
              if (!parent) return false;
              const siblingText = parent.innerText || '';
              const nums = siblingText.match(/\b\d{1,3}\b/g) || [];
              return nums.length >= 2;
            }).catch(() => false);
        if (!looksLikePagination) {
          log.debug(`Пропускаю "${t}" — не похоже на кнопку пагинации`);
          continue;
        }
      }

      log.info('Кнопка следующей страницы найдена: "' + t + '"');
      await el.click();
      await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE }).catch(() => {});
      await page.waitForTimeout(TIMEOUTS.AFTER_CLICK);

      const afterUrl  = page.url();
      const afterText = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);

      if (beforeUrl === afterUrl && beforeText === afterText) {
        log.warn('Пагинация не сработала — содержимое не изменилось');
        return false;
      }
      return true;
    } catch (_) {}
  }

  for (const suffix of ['page=' + nextNum, 'p=' + nextNum, 'seite=' + nextNum]) {
    try {
      const el = page.locator('a[href*="' + suffix + '"]').first();
      if (await el.isVisible({ timeout: TIMEOUTS.ELEMENT_VISIBLE })) {
        log.info('Кнопка по href найдена: ' + suffix);
        await el.click();
        await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE }).catch(() => {});
        await page.waitForTimeout(TIMEOUTS.AFTER_CLICK);
        if (page.url() === beforeUrl) {
          log.warn('Пагинация по href не сработала');
          return false;
        }
        return true;
      }
    } catch (_) {}
  }

  log.info('Кнопка следующей страницы НЕ найдена.');
  return false;
}

module.exports = { goToNextPage };
