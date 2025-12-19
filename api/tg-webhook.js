// api/tg-webhook.js
const { getOrCreateUser, setPremium } = require('../db');

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const API_URL = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

// 30 дней премиума
const PREMIUM_DAYS = 30;

function addDays(dateLike, days) {
  const d = dateLike instanceof Date ? new Date(dateLike) : new Date(dateLike);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

module.exports = async (req, res) => {
  // Telegram лучше всегда 200
  if (req.method !== 'POST') return res.status(200).send('OK');

  try {
    const update = req.body || {};

    // 1) pre_checkout_query обязательно подтвердить
    if (update.pre_checkout_query && API_URL) {
      const pc = update.pre_checkout_query;
      try {
        await fetch(`${API_URL}/answerPreCheckoutQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pre_checkout_query_id: pc.id, ok: true })
        });
      } catch (e) {
        console.error('answerPreCheckoutQuery error', e);
      }
    }

    // 2) успешный платёж → включаем премиум
    const sp = update?.message?.successful_payment;
    if (sp) {
      const from = update?.message?.from;
      const fromId = from?.id ? String(from.id) : null;

      let payload = null;
      try {
        payload = JSON.parse(sp.invoice_payload || '{}');
      } catch (_) {}

      const telegramId = payload?.telegramId ? String(payload.telegramId) : fromId;

      if (telegramId) {
        const user = await getOrCreateUser(telegramId);

        const now = new Date();
        let base = now;

        // если премиум ещё действует — продлеваем от той даты
        if (user.premium_until) {
          const cur = new Date(user.premium_until);
          if (cur > now) base = cur;
        }

        const untilIso = addDays(base, PREMIUM_DAYS);
        const paymentId = sp.telegram_payment_charge_id || null;

        await setPremium(user.id, untilIso, paymentId);
        console.log('Premium activated for', telegramId, 'until', untilIso);
      } else {
        console.error('successful_payment but no telegramId');
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('tg-webhook error', err);
    return res.status(200).json({ ok: true });
  }
};
