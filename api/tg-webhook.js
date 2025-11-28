// api/tg-webhook.js
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set');
}

const API_URL = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : null;

/**
 * Вебхук для Telegram.
 * Самое главное здесь — ответить на pre_checkout_query,
 * чтобы оплата не падала с BOT_PRECHECKOUT_TIMEOUT.
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    // Telegram ожидает 200 даже на GET, чтобы не ругаться
    return res.status(200).send('OK');
  }

  try {
    const update = req.body || {};

    // 1) Подтверждаем платёж
    if (update.pre_checkout_query && API_URL) {
      const pc = update.pre_checkout_query;
      console.log('pre_checkout_query:', pc);

      try {
        await fetch(`${API_URL}/answerPreCheckoutQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pre_checkout_query_id: pc.id,
            ok: true
          })
        });
      } catch (e) {
        console.error('answerPreCheckoutQuery error', e);
      }
    }

    // 2) Логируем успешные платежи (на будущее можно тут же включать премиум)
    if (update.message && update.message.successful_payment) {
      console.log('successful_payment:', update.message.successful_payment);
      // здесь можно будет при желании дернуть БД и включить премиум по from.id
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('tg-webhook error', err);
    // всё равно отвечаем 200, иначе Telegram будет отключать вебхук
    return res.status(200).json({ ok: true });
  }
};
