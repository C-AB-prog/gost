// api/pay-stars.js
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

const API_URL = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : null;

// Сколько звёзд за месяц
const STARS_PRICE = 129;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!API_URL) {
    return res.status(500).json({ error: 'BOT_TOKEN is not set' });
  }

  try {
    const { telegramId } = req.body || {};
    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }

    const title = 'ЕСКД Ассистент — 1 месяц';
    const description =
      'Безлимитные вопросы по ЕСКД и ГОСТам в течение 1 месяца.';
    const payload = JSON.stringify({
      type: 'eskd_month',
      telegramId: String(telegramId)
    });

    const resp = await fetch(`${API_URL}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        payload,
        provider_token: '', // для Stars пустая строка
        currency: 'XTR',
        prices: [
          {
            label: 'Подписка на 1 месяц',
            amount: STARS_PRICE // 129 звёзд
          }
        ]
      })
    });

    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      console.error('createInvoiceLink error', data);
      return res.status(502).json({ error: 'telegram_error', details: data });
    }

    return res.status(200).json({ invoice_url: data.result });
  } catch (err) {
    console.error('pay-stars api error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
