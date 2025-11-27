// api/yookassa-webhook.js
const { sql } = require('../db');

const SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SHOP_ID || !SECRET_KEY) {
    console.error('YOOKASSA env is not set for webhook');
    return res.status(500).json({ error: 'YooKassa is not configured' });
  }

  try {
    const body = req.body || {};

    // минимальная проверка структуры
    const event = body.event;
    const payment = body.object;

    if (!event || !payment) {
      console.error('Invalid webhook body', body);
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // нас интересует только успешная оплата
    if (event !== 'payment.succeeded') {
      // просто игнорируем другие события
      return res.status(200).json({ ok: true, ignored: true });
    }

    const paymentId = payment.id;
    const metadata = payment.metadata || {};
    const telegramId = metadata.telegramId || metadata.telegram_id;

    if (!telegramId) {
      console.error('No telegramId in payment metadata', payment);
      return res.status(200).json({ ok: true, no_telegram: true });
    }

    // включаем премиум на 30 дней
    try {
      await sql`
        UPDATE users
        SET
          is_premium = true,
          premium_until = GREATEST(
            COALESCE(premium_until, NOW()),
            NOW()
          ) + INTERVAL '30 days',
          last_payment_id = ${paymentId}
        WHERE telegram_id = ${telegramId}
      `;
    } catch (dbErr) {
      console.error('DB update error on webhook', dbErr);
      // всё равно возвращаем 200, чтобы YooKassa не спамила повторно
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('yookassa-webhook error', err);
    // для вебхуков лучше всё равно ответить 200,
    // чтобы YooKassa не долбила повторно
    return res.status(200).json({ ok: true, error: true });
  }
};
