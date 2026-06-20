'use strict';

const { TIMEOUTS } = require('../config/config');
const log    = require('../utils/logger');
const db     = require('../storage/db');
const { sleep } = require('../utils/sleep');
const { tgGetUpdates } = require('./sender');
const { handleCommand } = require('./commands');

async function pollOnce() {
  const offset = db.getKv('tgOffset', 0);
  const updates = await tgGetUpdates(offset);
  for (const u of updates) {
    db.setKv('tgOffset', u.update_id + 1);
    const msg = u.message;
    if (!msg || !msg.text) continue;
    const fromName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username;
    log.info('TG входящее:', msg.chat.id, msg.text);
    await handleCommand(msg.text.trim(), msg.chat.id, fromName)
      .catch(e => log.error('handleCommand error:', e.message));
  }
}

async function startPolling() {
  let consecutiveErrors = 0;
  const steps = TIMEOUTS.TG_BACKOFF_STEPS;

  while (true) {
    try {
      await pollOnce();
      consecutiveErrors = 0;
      await sleep(TIMEOUTS.TG_POLL_INTERVAL);
    } catch (e) {
      consecutiveErrors++;
      const delay = steps[Math.min(consecutiveErrors - 1, steps.length - 1)];
      log.warn(`poll error (подряд ${consecutiveErrors}):`, e.message, `— жду ${delay / 1000}с`);
      await sleep(delay);
    }
  }
}

module.exports = { startPolling };
