// api/activate-premium.js
const { sql, getOrCreateUser } = require('../db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { telegramId } = req.body || {};
    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }

    const tgId = String(telegramId);

    // убедимся, что юзер есть
    const user = await getOrCreateUser(tgId);

    // включаем премиум на 30 дней вперёд
    const rows = await sql`
      UPDATE users
      SET 
        is_premium = TRUE,
        premium_until = GREATEST(
          COALESCE(premium_until, NOW()),
          NOW()
        ) + INTERVAL '30 days',
        last_payment_id = COALESCE(last_payment_id, 'stars')
      WHERE id = ${user.id}
      RETURNING id, is_premium, premium_until;
    `;

    const updated = rows[0];

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
