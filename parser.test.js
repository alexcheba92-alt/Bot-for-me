'use strict';

const Database = require('better-sqlite3');
const fs        = require('fs');
const path      = require('path');
const { C }     = require('../config/config');
const log       = require('../utils/logger');

if (!fs.existsSync(C.outDir)) fs.mkdirSync(C.outDir, { recursive: true });

const db = new Database(C.dbPath);
db.pragma('journal_mode = WAL'); // безопаснее при параллельной записи/крашах

// ================================================================
//  СХЕМА
// ================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS apartments (
    id          TEXT PRIMARY KEY,   -- URL объявления
    address     TEXT,
    district    TEXT,
    rooms       REAL,
    rent        REAL,
    size        REAL,
    company     TEXT,
    wbs         TEXT,
    first_seen  INTEGER,
    last_seen   INTEGER
  );

  CREATE TABLE IF NOT EXISTS users (
    chat_id      TEXT PRIMARY KEY,
    name         TEXT,
    max_rent     REAL,
    min_rooms    REAL,
    district     TEXT,             -- одна подстрока района, или NULL = любой
    wbs_ok       INTEGER DEFAULT 1, -- 1 = показывать и WBS-квартиры тоже
    subscribed   INTEGER DEFAULT 1,
    is_owner     INTEGER DEFAULT 0,
    created_at   INTEGER,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sent_notifications (
    user_chat_id   TEXT,
    apartment_id   TEXT,
    sent_at        INTEGER,
    kind           TEXT, -- 'new' | 'gone'
    PRIMARY KEY (user_chat_id, apartment_id, kind)
  );

  CREATE TABLE IF NOT EXISTS kv_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS stats (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               INTEGER,
    checks_run       INTEGER,
    checks_failed    INTEGER,
    last_count       INTEGER,
    avg_duration_ms  INTEGER
  );
`);

// ================================================================
//  KV-НАСТРОЙКИ (замена мелких полей старого state.json)
// ================================================================
function getKv(key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv_settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (_) { return row.value; }
}

function setKv(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare(`
    INSERT INTO kv_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, v);
}

// ================================================================
//  ПОЛЬЗОВАТЕЛИ И ИХ ФИЛЬТРЫ
// ================================================================
function ensureOwner() {
  const existing = getUser(C.tgChatId);
  if (existing) return existing;
  return upsertUser(C.tgChatId, {
    name: 'Владелец',
    maxRent: C.defaultMaxRent,
    minRooms: C.defaultMinRooms,
    isOwner: true,
    subscribed: true,
  });
}

function getUser(chatId) {
  const row = db.prepare('SELECT * FROM users WHERE chat_id = ?').get(String(chatId));
  if (!row) return null;
  return rowToUser(row);
}

function rowToUser(row) {
  return {
    chatId:     row.chat_id,
    name:       row.name,
    maxRent:    row.max_rent,
    minRooms:   row.min_rooms,
    district:   row.district,
    wbsOk:      !!row.wbs_ok,
    subscribed: !!row.subscribed,
    isOwner:    !!row.is_owner,
    createdAt:  row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function upsertUser(chatId, fields = {}) {
  const id = String(chatId);
  const existing = db.prepare('SELECT * FROM users WHERE chat_id = ?').get(id);
  const now = Date.now();

  if (!existing) {
    db.prepare(`
      INSERT INTO users (chat_id, name, max_rent, min_rooms, district, wbs_ok, subscribed, is_owner, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fields.name ?? null,
      fields.maxRent ?? C.defaultMaxRent,
      fields.minRooms ?? C.defaultMinRooms,
      fields.district ?? null,
      fields.wbsOk === undefined ? 1 : (fields.wbsOk ? 1 : 0),
      fields.subscribed === undefined ? 1 : (fields.subscribed ? 1 : 0),
      fields.isOwner ? 1 : 0,
      now, now
    );
  } else {
    const merged = {
      name:       fields.name       ?? existing.name,
      max_rent:   fields.maxRent    ?? existing.max_rent,
      min_rooms:  fields.minRooms   ?? existing.min_rooms,
      district:   fields.district   !== undefined ? fields.district : existing.district,
      wbs_ok:     fields.wbsOk      !== undefined ? (fields.wbsOk ? 1 : 0) : existing.wbs_ok,
      subscribed: fields.subscribed !== undefined ? (fields.subscribed ? 1 : 0) : existing.subscribed,
      is_owner:   fields.isOwner    !== undefined ? (fields.isOwner ? 1 : 0) : existing.is_owner,
    };
    db.prepare(`
      UPDATE users SET name=?, max_rent=?, min_rooms=?, district=?, wbs_ok=?, subscribed=?, is_owner=?, last_seen_at=?
      WHERE chat_id = ?
    `).run(merged.name, merged.max_rent, merged.min_rooms, merged.district,
           merged.wbs_ok, merged.subscribed, merged.is_owner, now, id);
  }
  return getUser(id);
}

function getAllSubscribedUsers() {
  const rows = db.prepare('SELECT * FROM users WHERE subscribed = 1').all();
  return rows.map(rowToUser);
}

function getAllUsers() {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  return rows.map(rowToUser);
}

function touchUserLastSeen(chatId) {
  db.prepare('UPDATE users SET last_seen_at = ? WHERE chat_id = ?').run(Date.now(), String(chatId));
}

// ================================================================
//  КВАРТИРЫ — текущий снимок с сайта
// ================================================================
function upsertApartment(apt) {
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM apartments WHERE id = ?').get(apt.id);
  if (existing) {
    db.prepare(`
      UPDATE apartments SET address=?, district=?, rooms=?, rent=?, size=?, company=?, wbs=?, last_seen=?
      WHERE id=?
    `).run(apt.address, apt.district, num(apt.rooms), num(apt.rent), num(apt.size), apt.company, apt.wbs, now, apt.id);
  } else {
    db.prepare(`
      INSERT INTO apartments (id, address, district, rooms, rent, size, company, wbs, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(apt.id, apt.address, apt.district, num(apt.rooms), num(apt.rent), num(apt.size), apt.company, apt.wbs, now, now);
  }
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function getApartment(id) {
  return db.prepare('SELECT * FROM apartments WHERE id = ?').get(id);
}

function getAllKnownApartmentIds() {
  return db.prepare('SELECT id FROM apartments').all().map(r => r.id);
}

function deleteApartment(id) {
  db.prepare('DELETE FROM apartments WHERE id = ?').run(id);
}

// Удаляет из таблицы все квартиры, не входящие в переданный список текущих ID.
// Возвращает удалённые строки (для рассылки "квартира ушла").
function pruneGoneApartments(currentIds) {
  const known = db.prepare('SELECT * FROM apartments').all();
  const currentSet = new Set(currentIds);
  const gone = known.filter(a => !currentSet.has(a.id));
  const del = db.prepare('DELETE FROM apartments WHERE id = ?');
  for (const a of gone) del.run(a.id);
  return gone;
}

// ================================================================
//  ОТПРАВЛЕННЫЕ УВЕДОМЛЕНИЯ — защита от дублей при краше посередине рассылки
// ================================================================
function wasNotified(chatId, apartmentId, kind) {
  const row = db.prepare(`
    SELECT 1 FROM sent_notifications WHERE user_chat_id=? AND apartment_id=? AND kind=?
  `).get(String(chatId), apartmentId, kind);
  return !!row;
}

function markNotified(chatId, apartmentId, kind) {
  db.prepare(`
    INSERT OR IGNORE INTO sent_notifications (user_chat_id, apartment_id, sent_at, kind)
    VALUES (?, ?, ?, ?)
  `).run(String(chatId), apartmentId, Date.now(), kind);
}

// Чистим записи об отправленных "gone"-уведомлениях для квартир,
// которые давно удалены — иначе таблица растёт вечно
function pruneOldNotifications(olderThanMs = 30 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - olderThanMs;
  db.prepare('DELETE FROM sent_notifications WHERE sent_at < ?').run(cutoff);
}

// ================================================================
//  СТАТИСТИКА
// ================================================================
function recordStatTick({ checksRun, checksFailed, lastCount, avgDurationMs }) {
  db.prepare(`
    INSERT INTO stats (ts, checks_run, checks_failed, last_count, avg_duration_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(Date.now(), checksRun, checksFailed, lastCount, avgDurationMs);
}

function getLatestStats() {
  return db.prepare('SELECT * FROM stats ORDER BY id DESC LIMIT 1').get();
}

function getTopDistricts(limit = 10) {
  return db.prepare(`
    SELECT district, COUNT(*) as cnt FROM apartments
    WHERE district IS NOT NULL AND district != ''
    GROUP BY district ORDER BY cnt DESC LIMIT ?
  `).all(limit);
}

module.exports = {
  db,
  getKv, setKv,
  ensureOwner, getUser, upsertUser, getAllSubscribedUsers, getAllUsers, touchUserLastSeen,
  upsertApartment, getApartment, getAllKnownApartmentIds, deleteApartment, pruneGoneApartments,
  wasNotified, markNotified, pruneOldNotifications,
  recordStatTick, getLatestStats, getTopDistricts,
};
