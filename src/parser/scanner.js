'use strict';

const fs   = require('fs');
const path = require('path');
const { C } = require('../config/config');
const log   = require('../utils/logger');
const { parseAptText, isJunkUrl } = require('./parser');
const { goToNextPage } = require('./pagination');

// Сохраняет HTML и скриншот при подозрительном/нулевом результате —
// "золотая функция" для диагностики когда сайт меняет вёрстку
async function dumpDiagnostics(page, label) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const htmlPath = path.join(C.outDir, `error-${label}-${ts}.html`);
    const pngPath  = path.join(C.outDir, `error-${label}-${ts}.png`);
    const html = await page.content();
    fs.writeFileSync(htmlPath, html);
    await page.screenshot({ path: pngPath, fullPage: false });
    log.warn(`Диагностика сохранена: ${htmlPath}, ${pngPath}`);
    // Чистим старые дампы — оставляем только последние 5, чтобы не разрастался диск
    cleanupOldDumps();
  } catch (e) {
    log.error('Не удалось сохранить диагностику:', e.message);
  }
}

function cleanupOldDumps() {
  try {
    const files = fs.readdirSync(C.outDir)
      .filter(f => f.startsWith('error-'))
      .map(f => ({ f, t: fs.statSync(path.join(C.outDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(10)) {
      fs.unlinkSync(path.join(C.outDir, f));
    }
  } catch (_) {}
}

async function findLink(el) {
  try {
    const links = await el.locator('a[href]').all();

    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      const full = href.startsWith('http') ? href : C.baseUrl + href;
      if (isJunkUrl(full)) continue;
      if (/\/detail\/[\w-]+/i.test(href)) return full;
    }
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      const full = href.startsWith('http') ? href : C.baseUrl + href;
      if (isJunkUrl(full)) continue;
      if (/\/wohnungssuche\//i.test(href)) return full;
    }
    for (const link of links) {
      const href = (await link.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      const full = href.startsWith('http') ? href : C.baseUrl + href;
      if (isJunkUrl(full)) continue;
      if (href.match(/\d{4,}/) || /expose|objekt|wohnung|apartment/i.test(href)) return full;
    }
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

// Метод A: ищем карточки по общим CSS-селекторам
async function parseMethodA(page) {
  const result = [];
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
      result.push(apt);
    } catch (_) {}
  }
  return result;
}

// Метод B (fallback): идём по всем ссылкам страницы и смотрим родительский текст
async function parseMethodB(page) {
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
      result.push(apt);
    } catch (_) {}
  }
  return result;
}

// Парсит текущую страницу: пробует метод A, при пустом результате — метод B (fallback)
async function parseCurrentPage(page) {
  // Сайт рендерит карточки через Livewire (AJAX) ПОСЛЕ начальной загрузки —
  // на странице временно виден "Loading..." плейсхолдер. networkidle не
  // гарантирует что контент уже отрисован. Явно ждём появления текста
  // "Zimmer" или "€" в теле страницы, иначе оба метода парсинга получают
  // пустую/неполную DOM и результат становится нестабильным между прогонами.
  try {
    await page.waitForFunction(
      () => {
        const body = document.body.innerText || '';
        return body.includes('Zimmer') || body.includes('€');
      },
      { timeout: 15000 }
    );
  } catch (_) {
    log.warn('Контент с квартирами не появился за 15 сек — продолжаю как есть');
  }
  // Небольшая доп. пауза — даём дорисоваться всем карточкам, не только первой
  await page.waitForTimeout(800);

  const ssPath = path.join(C.outDir, 'results.png');
  const ssIsStale = !fs.existsSync(ssPath) ||
    (Date.now() - fs.statSync(ssPath).mtimeMs > 24 * 60 * 60 * 1000);
  if (ssIsStale) {
    await page.screenshot({ path: ssPath, fullPage: false }).catch(() => {});
  }

  let result = await parseMethodA(page);

  if (result.length === 0) {
    log.warn('Метод A дал 0 результатов, пробую метод B (fallback через ссылки)...');
    result = await parseMethodB(page);

    if (result.length === 0) {
      // Оба метода дали 0 — сохраняем диагностику, чтобы понять почему
      await dumpDiagnostics(page, 'zero-results');
    }
  }

  return result;
}

// Сканирует все страницы пагинации, дедуплицируя по URL на лету
async function scrapeAll(page) {
  log.info('Парсю квартиры...');

  const all = [];
  const seenUrls = new Set();
  let pageNum = 1;
  let lastPageSignature = null;

  while (true) {
    log.info(`Страница ${pageNum}...`);

    const items = await parseCurrentPage(page);

    const currentUrl = page.url();
    const urlsOnPage = items.map(a => a.url).filter(Boolean).sort().join('|');
    const sigShort = currentUrl + '::' + urlsOnPage;

    if (lastPageSignature !== null && sigShort === lastPageSignature) {
      log.warn('Страница идентична предыдущей — останавливаюсь.');
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

    log.info(`Страница ${pageNum}: ${items.length} найдено, ${newOnPage} новых уникальных`);
    lastPageSignature = sigShort;

    const hasNext = await goToNextPage(page, pageNum);
    if (!hasNext) {
      log.info(`Пагинация закончилась. Итого уникальных: ${all.length}`);
      break;
    }
    pageNum++;
    if (pageNum > 10) break;
  }

  return all;
}

module.exports = { scrapeAll, parseCurrentPage, dumpDiagnostics };
