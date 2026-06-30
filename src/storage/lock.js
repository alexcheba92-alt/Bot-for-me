'use strict';

const fs   = require('fs');
const path = require('path');
const { C } = require('../config/config');
const log = require('../utils/logger');

const lockFile = path.join(C.outDir, 'bot.lock');
const STALE_LOCK_MS = 2 * 60 * 1000; // 2 минуты

function acquireLock() {
  if (fs.existsSync(lockFile)) {
    // КРИТИЧНО: раньше тут была проверка через process.kill(pid, 0) —
    // это ненадёжно в контейнерах. При перезапуске Railway-контейнера
    // PID нумерация начинается заново, и старый PID из lock-файла может
    // случайно совпасть с реальным процессом в НОВОМ контейнере (например,
    // самим npm/node при старте). Это давало ложное "процесс уже жив",
    // и бот сам себя блокировал, переставая запускаться вообще.
    // Теперь используем время создания файла: если lock старше 2 минут,
    // он точно устарел (наш бот пишет свежий lock сразу при старте).
    let stat;
    try { stat = fs.statSync(lockFile); } catch (_) { stat = null; }

    const ageMs = stat ? Date.now() - stat.mtimeMs : Infinity;
    if (ageMs < STALE_LOCK_MS) {
      const oldPid = fs.readFileSync(lockFile, 'utf8').trim();
      console.error(`❌ Найден свежий lock-файл (PID ${oldPid}, возраст ${Math.round(ageMs / 1000)}с). ` +
        `Похоже, бот уже запущен или запускался очень недавно. Завершаю, чтобы не дублировать уведомления.`);
      process.exit(1);
    }

    log.info(`Lock-файл устарел (возраст ${Math.round(ageMs / 1000)}с) — перезаписываю`);
  }
  fs.writeFileSync(lockFile, String(process.pid));
}

function releaseLock() {
  try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch (_) {}
}

// Обновляет mtime lock-файла, пока бот жив. Без этого долгая работа (часы/дни)
// сама по себе никак не "старит" lock — мы пишем его только один раз при
// старте. Heartbeat не обязателен для корректности (TTL и так достаточно
// мал — 2 минуты), но это явная защита на случай будущих изменений логики.
function touchLock() {
  try { fs.writeFileSync(lockFile, String(process.pid)); } catch (_) {}
}

function startLockHeartbeat(intervalMs = 60000) {
  return setInterval(touchLock, intervalMs);
}

module.exports = { acquireLock, releaseLock, touchLock, startLockHeartbeat };
