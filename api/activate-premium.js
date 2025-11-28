// api/activate-premium.js
const { getOrCreateUser, setPremium } = require('../db');

// 30 дней премиума
const PREMIUM_DAYS = 30;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { telegramId } = req.body || {};
    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }

    const user = await getOrCreateUser(String(telegramId));

    const now = new Date();
    let baseDate = now;

    // если уже есть премиум в будущем — продлеваем от той даты
    if (user.premium_until) {
      const currentUntil = new Date(user.premium_until);
      if (currentUntil > now) {
        baseDate = currentUntil;
      }
    }

    baseDate.setDate(baseDate.getDate() + PREMIUM_DAYS);
    const untilIso = baseDate.toISOString();

    const updated = await setPremium(user.id, untilIso, null);

    return res.status(200).json({
      ok: true,
      is_premium: updated.is_premium,
      premium_until: updated.premium_until
    });
  } catch (err) {
    console.error('activate-premium error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
