// api/user.js
const { getOrCreateUser } = require('../db');

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

    const user = await getOrCreateUser(String(telegramId));

    const now = new Date();
    const hasPremium =
      user.is_premium &&
      user.premium_until &&
      new Date(user.premium_until) > now;

    return res.status(200).json({
      messages_used: user.messages_used ?? 0,
      free_limit: FREE_LIMIT,
      is_premium: hasPremium,
      premium_until: user.premium_until
    });
  } catch (err) {
    console.error('user api error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
