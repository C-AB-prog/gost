// api/pay-stars.js
const { getOrCreateUser } = require('../db');

const BOT_TOKEN = process.env.BOT_TOKEN;

// цена подписки в звёздах (пример: 300 звёзд)
const STARS_PRICE = 129;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegramId } = req.body || {};
  if (!telegramId) {
    return res.status(400).json({ error: 'telegramId is required' });
  }

  const tgId = String(telegramId);

  // если бот-токен не задан — мягкое сообщение
  if (!BOT_TOKEN) {
    console.warn('BOT_TOKEN is not set, returning mock message');
    return res.status(200).json({
      message:
        'Оплата пока недоступна: бот оплаты ещё не настроен (нет BOT_TOKEN).'
    });
  }

  try {
    // просто убеждаемся, что юзер есть в БД
    await getOrCreateUser(tgId);

    // Параметры инвойса для Stars
    // Bot API: createInvoiceLink, currency: XTR, prices: [{amount, label}] 
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`;

    const payloadObj = {
      type: 'eskd_month_subscription',
      telegramId: tgId
    };

    const body = {
      title: 'ЕСКД Ассистент — 1 месяц',
      description: 'Подписка на 1 месяц без лимита обращений к ассистенту.',
      payload: JSON.stringify(payloadObj),
      provider_token: '', // для Stars — пустая строка
      currency: 'XTR',
      prices: [
        {
          label: 'Подписка на 1 месяц',
          amount: STARS_PRICE // количество звёзд
        }
      ],
      // можно добавить max_tip_amount, suggested_tip_amounts и т.п. при желании
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data || !data.ok) {
      console.error('Telegram createInvoiceLink error', response.status, data);
      return res.status(200).json({
        message:
          'Оплата пока недоступна: не удалось создать ссылку на оплату в звёздах.'
      });
    }

    const invoiceLink = data.result; // это строка-URL на оплату

    return res.status(200).json({
      invoice_link: invoiceLink
    });
  } catch (err) {
    console.error('pay-stars server error', err);
    return res.status(200).json({
      message:
        'Что-то пошло не так при создании платежа. Попробуйте позже.'
    });
  }
};
