'use strict';

const fs   = require('fs');
const path = require('path');
const { C, TIMEOUTS } = require('../config/config');
const log  = require('../utils/logger');
const { sleep } = require('../utils/sleep');
const db   = require('../storage/db');
const { ensureBrowser, resetSession, closeBrowser, safeAction, getPage, setLoggedIn } = require('../browser/browser');
const { ensureLoggedIn } = require('../browser/auth');
const { scrapeAll } = require('../parser/scanner');
const { tgText, tgPhoto } = require('../telegram/sender');
const { matchesUser } = require('../telegram/commands');

let errCount = 0;
let checksRun = 0;
let checksFailed = 0;
let isChecking = false;
const durations = [];

function msgNew(apt) {
  const lines = [
    '🏠 <b>Новая квартира!</b>',
    '',
    apt.address  ? `📍 ${apt.address}`                         : null,
    apt.district ? `🗺 Район: ${apt.district}`                 : null,
    apt.rooms    ? `🛏 Комнат: <b>${apt.rooms}</b>`            : null,
    apt.size     ? `📐 Площадь: <b>${apt.size} м²</b>`        : null,
    apt.rent     ? `💶 Kaltmiete: <b>${apt.rent} €</b>`       : null,
    apt.company  ? `🏢 ${apt.company}`                         : null,
    apt.wbs      ? `🔑 ${apt.wbs}`                            : null,
  ].filter(Boolean).join('\n');
  return {
    text: lines,
    markup: { inline_keyboard: [[{ text: '🔗 Открыть на inberlinwohnen.de', url: apt.url }]] },
  };
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
//  ОСНОВНАЯ ЛОГИКА ПРОВЕРКИ
// ================================================================
async function runCheckInternal() {
  const t0 = Date.now();
  await safeAction(() => ensureBrowser());
  log.debug(`[timing] ensureBrowser: ${Date.now() - t0}ms`);

  const t1 = Date.now();
  await safeAction(() => ensureLoggedIn());
  log.debug(`[timing] ensureLoggedIn: ${Date.now() - t1}ms`);

  const t2 = Date.now();
  const page = getPage();
  const apartments = await safeAction(() => scrapeAll(page));
  log.debug(`[timing] scrapeAll: ${Date.now() - t2}ms`);

  const prevCount = db.getKv('lastTotalCount', 0);

  // ── Защита от ложного "все квартиры пропали" ──
  if (apartments.length === 0 && prevCount >= 3) {
    log.warn(`⚠️ ПОДОЗРИТЕЛЬНО: 0 квартир, было ${prevCount}. Похоже на сбой парсинга — пропускаю уведомления.`);
    await tgText(C.tgChatId,
      `⚠️ Подозрительный результат: 0 квартир найдено (было ${prevCount}).\n` +
      `Похоже на сбой сканирования. Уведомления пропущены, пробую снова через 5 минут.`
    ).catch(() => {});
    setLoggedIn(false); // форсируем релогин
    return;
  }

  // ── Валидация: квартира без URL непригодна для уведомлений и дедупа.
  //     Раньше такие записи могли попасть в базу и потом прийти как
  //     "ушла" без адреса/ссылки. Отсекаем их здесь, до сохранения. ──
  const validApartments = apartments.filter(a => {
    if (!a.url || !a.id) {
      log.warn('Квартира без URL отброшена (не сохраняется в базу):', JSON.stringify(a).slice(0, 150));
      return false;
    }
    return true;
  });
  if (validApartments.length !== apartments.length) {
    log.warn(`Отброшено ${apartments.length - validApartments.length} квартир без URL из ${apartments.length}`);
  }

  validApartments.slice(0, 5).forEach((a, i) =>
    log.debug(`[${i}] rooms=${a.rooms} rent=${a.rent}€ size=${a.size}m² | ${a.address} | ${(a.url || '').slice(0, 70)}`)
  );

  const currentIds = validApartments.map(a => a.id);

  // ── Определяем "новые" квартиры ──
  // Раньше критерием было "не в таблице apartments". Но если процесс
  // упал ПОСЛЕ записи в базу, но ДО отправки уведомления (например,
  // как в случае таймаута в 6 утра), квартира оказывается в базе
  // без единого уведомления — и навсегда считается "старой".
  // Теперь дополнительно проверяем: была ли реально отправка хотя бы
  // одному подписчику. Если нет — считаем квартиру новой, даже если
  // она уже есть в таблице apartments.
  const newApts = validApartments.filter(a => {
    const inDb = !!db.getApartment(a.id);
    if (!inDb) return true; // точно новая, в базе не было вообще
    // в базе есть, но проверим — отправляли ли хоть раз уведомление о ней
    const everNotified = db.wasApartmentEverNotified(a.id);
    return !everNotified;
  });

  const goneApts = db.pruneGoneApartments(currentIds)
    .filter(a => a.address || a.url); // не уведомляем о "пропаже" совсем пустых записей (старый мусор в базе)

  for (const a of validApartments) db.upsertApartment(a);

  log.info(`Итого: ${validApartments.length} | Новых: ${newApts.length} | Ушло: ${goneApts.length}`);

  const isFirstRun = db.getKv('firstRunDone', false) === false;

  if (isFirstRun) {
    db.setKv('firstRunDone', true);
    const owner = db.ensureOwner();
    await tgText(C.tgChatId,
      `🤖 <b>Бот запущен!</b>\n\n` +
      `🔍 Мониторю inberlinwohnen.de\n` +
      `💶 Kaltmiete до ${owner.maxRent} €\n` +
      `🛏 Комнат от ${owner.minRooms}\n` +
      `⏱ Каждые ${C.intervalMs / 60000} мин\n\n` +
      `📊 Сейчас по фильтру: <b>${validApartments.length} квартир</b>\n\n` +
      `Команды: /help`
    );
    const ssPath = path.join(C.outDir, 'results.png');
    if (fs.existsSync(ssPath)) await tgPhoto(C.tgChatId, ssPath, `Страница поиска (${validApartments.length} квартир)`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  ПЕРСОНАЛЬНАЯ РАССЫЛКА: сайт сканируется ОДИН раз,
  //  а фильтрация и уведомления — отдельно для каждого подписчика.
  //  У мамы свой бюджет, у брата свой — каждый получает только то,
  //  что подходит именно ему.
  // ═══════════════════════════════════════════════════════════════
  const users = db.getAllSubscribedUsers();

  for (const apt of newApts) {
    for (const user of users) {
      if (!matchesUser(user, apt)) continue;
      if (db.wasNotified(user.chatId, apt.id, 'new')) continue; // защита от дублей при краше

      const { text, markup } = msgNew(apt);
      const sent = await tgText(user.chatId, text, { reply_markup: markup });
      if (sent) db.markNotified(user.chatId, apt.id, 'new');
    }
  }

  for (const apt of goneApts) {
    for (const user of users) {
      if (!matchesUser(user, apt)) continue;
      if (db.wasNotified(user.chatId, apt.id, 'gone')) continue;

      const sent = await tgText(user.chatId, msgGone(apt));
      if (sent) db.markNotified(user.chatId, apt.id, 'gone');
    }
  }

  db.setKv('lastTotalCount', validApartments.length);
  db.pruneOldNotifications();
  errCount = 0;
}

// ================================================================
//  ОБЁРТКА С ГЛОБАЛЬНЫМ ТАЙМАУТОМ
// ================================================================
async function runCheck() {
  let timeoutHandle;
  const startedAt = Date.now();
  try {
    await Promise.race([
      runCheckInternal(),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Проверка зависла дольше 3 минут')),
          TIMEOUTS.GLOBAL_CHECK_TIMEOUT
        );
      }),
    ]);
    durations.push(Date.now() - startedAt);
    if (durations.length > 50) durations.shift();
  } catch (e) {
    errCount++;
    checksFailed++;
    log.error('ОШИБКА:', e.message);
    await tgText(C.tgChatId, `⚠️ Ошибка #${errCount}:\n<code>${e.message}</code>`).catch(() => {});

    await resetSession();
    if (errCount % 3 === 0) await closeBrowser();
  } finally {
    clearTimeout(timeoutHandle);
    checksRun++;
    const avgDuration = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    db.recordStatTick({
      checksRun, checksFailed,
      lastCount: db.getKv('lastTotalCount', 0),
      avgDurationMs: avgDuration,
    });
  }
}

// ================================================================
//  ЕЖЕДНЕВНЫЙ HEALTH-CHECK
// ================================================================
const botStartedAt = Date.now();
let lastHealthReportAt = Date.now();

async function maybeSendHealthReport() {
  if (Date.now() - lastHealthReportAt < TIMEOUTS.HEALTH_REPORT_EVERY) return;
  lastHealthReportAt = Date.now();

  const uptimeDays = ((Date.now() - botStartedAt) / (24 * 60 * 60 * 1000)).toFixed(1);
  const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);

  await tgText(C.tgChatId,
    `✅ <b>Бот жив</b>\n\n` +
    `Проверок выполнено: ${checksRun}\n` +
    `Ошибок: ${checksFailed}\n` +
    `Квартир сейчас: ${db.getKv('lastTotalCount', 0)}\n` +
    `Память: ${memMb} MB\n` +
    `Uptime: ${uptimeDays} дней`
  ).catch(() => {});
}

// ================================================================
//  ГЛАВНЫЙ ЦИКЛ
// ================================================================
async function checkLoop() {
  while (true) {
    if (isChecking) {
      log.warn('⚠️ Предыдущая проверка ещё идёт — пропускаю цикл');
      await sleep(5000);
      continue;
    }
    isChecking = true;
    try {
      await runCheck();
    } finally {
      isChecking = false;
    }
    await maybeSendHealthReport();
    log.info(`Жду ${C.intervalMs / 60000} мин до следующей проверки...`);
    await sleep(C.intervalMs);
  }
}

module.exports = { checkLoop, runCheck };
