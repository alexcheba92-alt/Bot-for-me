'use strict';

const { checkConfig } = require('./config/config');
const log = require('./utils/logger');
const db  = require('./storage/db');
const { acquireLock, releaseLock, startLockHeartbeat } = require('./storage/lock');
const { checkLoop } = require('./monitor/scanner');
const { startPolling } = require('./telegram/polling');
const { closeBrowser } = require('./browser/browser');
const { tgText } = require('./telegram/sender');
const { C } = require('./config/config');

async function main() {
  checkConfig();
  acquireLock();
  startLockHeartbeat();
  db.ensureOwner();
  db.cleanupJunkApartments(); // чистим мусор, накопленный до исправления валидации

  // Одноразовый сброс после фикса бага с неправильным rooms=1 для всех квартир
  // (regex "Zi\." ловил случайный текст из меню/копирайта). Срабатывает только
  // один раз — флаг в kv_settings не даст повториться при следующих перезапусках.
  if (!db.getKv('roomsBugFixApplied_2026_06_22', false)) {
    db.resetApartmentsTable();
    db.setKv('roomsBugFixApplied_2026_06_22', true);
    log.info('Применён одноразовый сброс базы квартир после фикса парсинга комнат');
  }
  log.info('=== Бот inberlinwohnen.de запущен (модульная версия) ===');

  startPolling(); // не await — работает в фоне параллельно с checkLoop
  await checkLoop();
}

process.on('SIGINT', async () => {
  log.info('SIGINT — завершаю проверку и закрываю браузер...');
  releaseLock();
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log.info('SIGTERM — завершаю проверку и закрываю браузер...');
  releaseLock();
  await closeBrowser();
  process.exit(0);
});

process.on('uncaughtException', async (e) => {
  log.error('UNCAUGHT:', e.stack);
  try { await tgText(C.tgChatId, `💥 Критическая ошибка:\n<code>${e.message}</code>`); } catch (_) {}
});

process.on('unhandledRejection', async (reason) => {
  log.error('UNHANDLED REJECTION:', reason instanceof Error ? reason.stack : String(reason));
  try { await tgText(C.tgChatId, `💥 Необработанная ошибка промиса:\n<code>${String(reason).slice(0, 300)}</code>`); } catch (_) {}
});

main().catch(async (e) => {
  log.error('FATAL:', e.stack);
  try { await tgText(C.tgChatId, `💥 Не запустился:\n${e.message}`); } catch (_) {}
  process.exit(1);
});
