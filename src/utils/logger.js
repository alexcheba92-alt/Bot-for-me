'use strict';

const fs   = require('fs');
const path = require('path');
const { C } = require('../config/config');

if (!fs.existsSync(C.outDir)) fs.mkdirSync(C.outDir, { recursive: true });

// ================================================================
//  РОТАЦИЯ ЛОГОВ — bot.log не растёт бесконечно
//  Если файл больше 10 МБ, переименовываем в bot.log.1 (старый
//  bot.log.1 удаляется). Так в худшем случае на диске лежит
//  максимум ~20 МБ логов, а не гигабайты за год.
// ================================================================
const logFile = path.join(C.outDir, 'bot.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 МБ

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(logFile)) return;
    const { size } = fs.statSync(logFile);
    if (size < MAX_LOG_SIZE) return;
    const oldFile = logFile + '.1';
    if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    fs.renameSync(logFile, oldFile);
  } catch (_) { /* не критично, просто пропускаем ротацию в этот раз */ }
}

function writeLine(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.join(' ')}`;
  console.log(line);
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFile, line + '\n');
  } catch (_) {}
}

const log = {
  info:  (...a) => writeLine('INFO',  a),
  warn:  (...a) => writeLine('WARN',  a),
  error: (...a) => writeLine('ERROR', a),
  debug: (...a) => writeLine('DEBUG', a),
};

// Обратная совместимость: log(...) работает как log.info(...)
function legacyLog(...a) { writeLine('INFO', a); }
Object.assign(legacyLog, log);

module.exports = legacyLog;
