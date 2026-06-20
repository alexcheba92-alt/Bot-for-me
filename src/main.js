'use strict';

const { checkConfig } = require('./config/config');
const log = require('./utils/logger');
const db  = require('./storage/db');
const { acquireLock, releaseLock } = require('./storage/lock');
const { checkLoop } = require('./monitor/scanner');
const { startPolling } = require('./telegram/polling');
const { closeBrowser } = require('./browser/browser');
const { tgText } = require('./telegram/sender');
const { C } = require('./config/config');

async function main() {
  checkConfig();
  acquireLock();
  db.ensureOwner();
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
