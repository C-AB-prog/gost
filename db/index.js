// db/index.js
const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const sql = neon(process.env.DATABASE_URL);

async function getOrCreateUser(telegramId) {
  const rows = await sql`
    SELECT * FROM users WHERE telegram_id = ${telegramId}
  `;
  if (rows.length > 0) return rows[0];

  const inserted = await sql`
    INSERT INTO users (telegram_id)
    VALUES (${telegramId})
    RETURNING *
  `;
  return inserted[0];
}

async function incrementMessagesUsed(userId) {
  const rows = await sql`
    UPDATE users
    SET messages_used = messages_used + 1
    WHERE id = ${userId}
    RETURNING *
  `;
  return rows[0];
}

module.exports = {
  sql,
  getOrCreateUser,
  incrementMessagesUsed
};
