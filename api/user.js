// api/user.js
const { getOrCreateUser, clearExpiredPremium } = require('../db');

const FREE_LIMIT = 3;

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.method === 'POST' ? req.body : req.query;
    const telegramId = body && (body.telegramId || body.telegram_id);

    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }

    let user = await getOrCreateUser(String(telegramId));

    // проверяем, не истёк ли премиум
    let isPremium = false;
    let premiumUntil = user.premium_until ? new Date(user.premium_until) : null;
    const now = new Date();

    if (user.is_premium && premiumUntil && premiumUntil > now) {
      isPremium = true;
    } else if (user.is_premium && premiumUntil && premiumUntil <= now) {
      // истёк — сбросим флаг в БД
      user = await clearExpiredPremium(user.id);
      isPremium = false;
      premiumUntil = null;
    }

    return res.status(200).json({
      messages_used: user.messages_used,
      free_limit: FREE_LIMIT,
      is_premium: isPremium,
      premium_until: premiumUntil ? premiumUntil.toISOString() : null
    });
  } catch (err) {
    console.error('user api error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
