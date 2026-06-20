'use strict';

const fs   = require('fs');
const path = require('path');
const { C } = require('../config/config');
const log = require('../utils/logger');

const lockFile = path.join(C.outDir, 'bot.lock');

function acquireLock() {
  if (fs.existsSync(lockFile)) {
    const oldPid = fs.readFileSync(lockFile, 'utf8').trim();
    try {
      process.kill(Number(oldPid), 0); // не убивает, просто проверяет существование процесса
      console.error(`❌ Бот уже запущен (PID ${oldPid}). Завершаю, чтобы не дублировать уведомления.`);
      process.exit(1);
    } catch (_) {
      log.info('Найден устаревший lock-файл (процесс не существует), перезаписываю');
    }
  }
  fs.writeFileSync(lockFile, String(process.pid));
}

function releaseLock() {
  try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch (_) {}
}

module.exports = { acquireLock, releaseLock };
