'use strict';

const { C }   = require('../config/config');
const db      = require('../storage/db');
const { tgText } = require('./sender');

function fmtUserFilters(u) {
  return [
    `💶 Максимальная аренда: <b>${u.maxRent} €</b>`,
    `🛏 Минимум комнат: <b>${u.minRooms}</b>`,
    `🗺 Район: <b>${u.district || 'любой'}</b>`,
    `🔑 Показывать WBS-квартиры: <b>${u.wbsOk ? 'да' : 'нет'}</b>`,
    `🔔 Подписка: <b>${u.subscribed ? 'включена' : 'на паузе'}</b>`,
  ].join('\n');
}

function helpText(u) {
  return [
    '🤖 <b>Команды бота:</b>',
    '',
    '/start — приветствие и регистрация',
    '/myfilters — посмотреть свои фильтры',
    '/rent N — макс. Kaltmiete € (например: /rent 700)',
    '/rooms N — мин. комнат (например: /rooms 2)',
    '/district Имя — фильтр по району (например: /district Neukölln)',
    '/district none — убрать фильтр по району',
    '/wbs yes|no — показывать ли WBS-квартиры',
    '/pause — приостановить уведомления',
    '/resume — снова получать уведомления',
    '/status — сколько квартир сейчас подходит под твой фильтр',
    '/debugme — диагностика: подписка и история уведомлений',
    '/help — это сообщение',
    '',
    fmtUserFilters(u),
  ].join('\n');
}

function ownerHelpExtra() {
  return [
    '',
    '👑 <b>Команды владельца:</b>',
    '/users — список всех подписчиков',
    '/userinfo CHAT_ID — детали конкретного пользователя',
    '/stats — статистика бота',
    '/topdistricts — самые частые районы среди объявлений',
    '/announce ТЕКСТ — разослать сообщение всем подписчикам',
  ].join('\n');
}

async function handleCommand(text, chatId, fromName) {
  const isOwner = String(chatId) === String(C.tgChatId);
  db.touchUserLastSeen(chatId);

  // ── /start — регистрирует пользователя с дефолтными фильтрами ──
  if (text === '/start') {
    const existing = db.getUser(chatId);
    const u = existing || db.upsertUser(chatId, {
      name: fromName || null,
      isOwner,
      subscribed: true,
    });
    let msg = `👋 Привет! Я мониторю квартиры на inberlinwohnen.de.\n\n${helpText(u)}`;
    if (isOwner) msg += ownerHelpExtra();
    await tgText(chatId, msg);
    return;
  }

  // Дальше команды требуют что пользователь уже существует —
  // если нет, создаём с дефолтами по ходу
  let u = db.getUser(chatId) || db.upsertUser(chatId, { name: fromName || null, isOwner });

  if (text === '/help') {
    let msg = helpText(u);
    if (isOwner) msg += ownerHelpExtra();
    await tgText(chatId, msg);
    return;
  }

  if (text === '/myfilters') {
    await tgText(chatId, `⚙️ <b>Твои фильтры:</b>\n\n${fmtUserFilters(u)}`);
    return;
  }

  if (text === '/status') {
    const count = db.getKv('lastTotalCount', 0);
    const matching = countMatchingForUser(u);
    await tgText(chatId,
      `📊 Всего квартир на сайте сейчас: <b>${count}</b>\n` +
      `🎯 Подходят под твой фильтр: <b>${matching}</b>`
    );
    return;
  }

  if (text === '/debugme') {
    const recentNotifs = db.db.prepare(`
      SELECT apartment_id, kind, sent_at FROM sent_notifications
      WHERE user_chat_id = ? ORDER BY sent_at DESC LIMIT 5
    `).all(String(chatId));
    const notifLines = recentNotifs.length
      ? recentNotifs.map(n => `${new Date(n.sent_at).toLocaleString('ru-RU')} — ${n.kind} — ${n.apartment_id.slice(0, 50)}`).join('\n')
      : 'нет отправленных уведомлений';
    await tgText(chatId,
      `🔍 <b>Диагностика для chat_id=${chatId}</b>\n\n` +
      `Зарегистрирован: ${u ? 'да' : 'нет'}\n` +
      `Подписан (subscribed): ${u.subscribed ? 'да' : 'нет'}\n` +
      `${fmtUserFilters(u)}\n\n` +
      `<b>Последние 5 уведомлений:</b>\n${notifLines}`
    );
    return;
  }

  // ── /rent N — персональный фильтр ──
  const rentMatch = text.match(/^\/rent\s+(\d+)/);
  if (rentMatch) {
    db.upsertUser(chatId, { maxRent: parseInt(rentMatch[1], 10) });
    await tgText(chatId, `✅ Максимальная аренда обновлена: <b>${rentMatch[1]} €</b>`);
    return;
  }

  // ── /rooms N — персональный фильтр ──
  const roomsMatch = text.match(/^\/rooms\s+(\d+)/);
  if (roomsMatch) {
    db.upsertUser(chatId, { minRooms: parseInt(roomsMatch[1], 10) });
    await tgText(chatId, `✅ Минимум комнат обновлён: <b>${roomsMatch[1]}</b>`);
    return;
  }

  // ── /district Name | /district none ──
  const districtMatch = text.match(/^\/district\s+(.+)/i);
  if (districtMatch) {
    const value = districtMatch[1].trim();
    if (value.toLowerCase() === 'none' || value.toLowerCase() === 'любой') {
      db.upsertUser(chatId, { district: null });
      await tgText(chatId, '✅ Фильтр по району убран — теперь любой район.');
    } else {
      db.upsertUser(chatId, { district: value });
      await tgText(chatId, `✅ Район обновлён: <b>${value}</b>`);
    }
    return;
  }

  // ── /wbs yes|no ──
  const wbsMatch = text.match(/^\/wbs\s+(yes|no|да|нет)/i);
  if (wbsMatch) {
    const ok = /yes|да/i.test(wbsMatch[1]);
    db.upsertUser(chatId, { wbsOk: ok });
    await tgText(chatId, `✅ Показ WBS-квартир: <b>${ok ? 'включён' : 'выключен'}</b>`);
    return;
  }

  if (text === '/pause') {
    db.upsertUser(chatId, { subscribed: false });
    await tgText(chatId, '⏸ Уведомления приостановлены. /resume — чтобы включить обратно.');
    return;
  }

  if (text === '/resume') {
    db.upsertUser(chatId, { subscribed: true });
    await tgText(chatId, '▶️ Уведомления снова включены.');
    return;
  }

  // ════════════════════════════════════════════════════════════
  //  КОМАНДЫ ВЛАДЕЛЬЦА
  // ════════════════════════════════════════════════════════════
  if (text === '/users') {
    if (!isOwner) return tgText(chatId, '⛔ Только для владельца.');
    const all = db.getAllUsers();
    const lines = all.map((usr, i) => {
      const tag = usr.isOwner ? ' 👑' : '';
      const status = usr.subscribed ? '' : ' ⏸';
      return `${i + 1}. ${usr.name || usr.chatId}${tag}${status} — до ${usr.maxRent}€, от ${usr.minRooms} комн.`;
    });
    await tgText(chatId, `👥 <b>Пользователей: ${all.length}</b>\n\n${lines.join('\n')}`);
    return;
  }

  const userInfoMatch = text.match(/^\/userinfo\s+(\d+)/);
  if (userInfoMatch) {
    if (!isOwner) return tgText(chatId, '⛔ Только для владельца.');
    const target = db.getUser(userInfoMatch[1]);
    if (!target) return tgText(chatId, 'Пользователь не найден.');
    const lastSeenAgo = target.lastSeenAt ? humanAgo(Date.now() - target.lastSeenAt) : 'никогда';
    await tgText(chatId,
      `<b>ID:</b> ${target.chatId}\n` +
      `<b>Имя:</b> ${target.name || '—'}\n` +
      `${fmtUserFilters(target)}\n` +
      `<b>Последняя активность:</b> ${lastSeenAgo}`
    );
    return;
  }

  if (text === '/stats') {
    if (!isOwner) return tgText(chatId, '⛔ Только для владельца.');
    const s = db.getLatestStats();
    const users = db.getAllUsers();
    const activeCount = users.filter(u2 => u2.subscribed).length;
    await tgText(chatId,
      `📊 <b>Статистика бота</b>\n\n` +
      `Подписчиков всего: ${users.length}\n` +
      `Активных: ${activeCount}\n` +
      `Проверок выполнено: ${s?.checks_run ?? '—'}\n` +
      `Ошибок: ${s?.checks_failed ?? '—'}\n` +
      `Квартир сейчас: ${s?.last_count ?? '—'}\n` +
      `Среднее время проверки: ${s ? Math.round(s.avg_duration_ms / 1000) + ' сек' : '—'}`
    );
    return;
  }

  if (text === '/topdistricts') {
    if (!isOwner) return tgText(chatId, '⛔ Только для владельца.');
    const top = db.getTopDistricts(10);
    if (top.length === 0) return tgText(chatId, 'Пока нет данных.');
    const lines = top.map(t => `${t.district}: ${t.cnt}`);
    await tgText(chatId, `🗺 <b>Топ районов по объявлениям:</b>\n\n${lines.join('\n')}`);
    return;
  }

  const announceMatch = text.match(/^\/announce\s+([\s\S]+)/);
  if (announceMatch) {
    if (!isOwner) return tgText(chatId, '⛔ Только для владельца.');
    const message = announceMatch[1].trim();
    const recipients = db.getAllSubscribedUsers();
    for (const r of recipients) {
      await tgText(r.chatId, `📢 <b>Объявление:</b>\n\n${message}`);
    }
    await tgText(chatId, `✅ Отправлено ${recipients.length} подписчикам.`);
    return;
  }

  if (text.startsWith('/')) {
    await tgText(chatId, 'Не знаю такой команды. Напиши /help');
  }
}

function humanAgo(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} ч назад`;
  return `${Math.floor(hrs / 24)} дн назад`;
}

// Считает сколько квартир из текущей базы подходит под фильтр пользователя
function countMatchingForUser(u) {
  const rows = db.db.prepare('SELECT * FROM apartments').all();
  return rows.filter(a => matchesUser(u, a)).length;
}

// ================================================================
//  ГЛАВНАЯ ЛОГИКА СОПОСТАВЛЕНИЯ: подходит ли квартира под фильтр юзера
// ================================================================
function matchesUser(user, apt) {
  const rent  = apt.rent;
  const rooms = apt.rooms;

  if (rent  != null && rent  > user.maxRent)  return false;
  if (rooms != null && rooms < user.minRooms) return false;

  if (user.district) {
    const wanted = user.district.toLowerCase();
    const aptDistrict = (apt.district || '').toLowerCase();
    const aptAddress  = (apt.address  || '').toLowerCase();
    if (!aptDistrict.includes(wanted) && !aptAddress.includes(wanted)) return false;
  }

  if (!user.wbsOk && apt.wbs) return false;

  return true;
}

module.exports = { handleCommand, matchesUser, helpText, ownerHelpExtra };
