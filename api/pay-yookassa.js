// api/pay-yookassa.js
const crypto = require('crypto');
const { getOrCreateUser } = require('../db');

const SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;
const RETURN_URL =
  process.env.YOOKASSA_RETURN_URL || 'https://gost-three.vercel.app/';

// цена подписки за 1 месяц
const SUB_PRICE = '149.00'; // RUB

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SHOP_ID || !SECRET_KEY) {
    console.error('YOOKASSA env is not set');
    return res.status(500).json({ error: 'YooKassa is not configured' });
  }

  try {
    const { telegramId } = req.body || {};
    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }

    const tgId = String(telegramId);

    // убеждаемся, что юзер есть в БД
    await getOrCreateUser(tgId);

    // формируем тело платежа
    const idempotenceKey = crypto.randomUUID();
    const payload = {
      amount: {
        value: SUB_PRICE,
        currency: 'RUB'
      },
      capture: true, // сразу списать
      description: 'ЕСКД Ассистент — подписка на 1 месяц',
      confirmation: {
        type: 'redirect',
        return_url: RETURN_URL
      },
      metadata: {
        telegramId: tgId
      }
    };

    const authToken = Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString(
      'base64'
    );

    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${authToken}`,
        'Idempotence-Key': idempotenceKey
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => null);
      console.error('YooKassa create payment error', response.status, text);
      return res
        .status(502)
        .json({ error: 'yookassa_error', details: text || null });
    }

    const data = await response.json();

    const confirmationUrl =
      data.confirmation && data.confirmation.confirmation_url;

    if (!confirmationUrl) {
      console.error('No confirmation_url in YooKassa response', data);
      return res
        .status(502)
        .json({ error: 'no_confirmation_url_from_yookassa' });
    }

    // отдаем фронту ссылку на оплату
    return res.status(200).json({
      confirmation_url: confirmationUrl,
      payment_id: data.id
    });
  } catch (err) {
    console.error('pay-yookassa server error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
