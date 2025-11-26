// api/chat.js
const { getOrCreateUser, incrementMessagesUsed } = require('../db');

const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
const FREE_LIMIT = 3;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!OPENAI_KEY) {
    return res.status(500).json({ error: 'OPENAI_KEY is not set' });
  }

  try {
    const { telegramId, message: userMessage } = req.body || {};

    if (!telegramId || !userMessage) {
      return res.status(400).json({
        error: 'telegramId and message are required'
      });
    }

    const tgId = String(telegramId);

    // 1) получаем / создаём пользователя
    const user = await getOrCreateUser(tgId);

    // 2) проверка лимита
    if (user.messages_used >= FREE_LIMIT) {
      return res.status(403).json({
        error: 'limit_reached',
        message:
          'Ваши 3 бесплатных обращения к ЕСКД ассистенту закончились. В ближайшее время здесь появится оформление подписки.',
        messages_used: user.messages_used,
        free_limit: FREE_LIMIT
      });
    }

    // 3) system prompt (твоя версия, аккуратно оформил)
    const systemPrompt = `
Вы — эксперт по ЕСКД (ГОСТы на оформление конструкторской документации).
Отвечайте по-русски чётко и практично. Если вопрос требует точной нормы — укажите,
что это следует проверить в официальном ГОСТе и предложите шаги проверки.

Формат ответа:
1) Краткий вывод (1–2 предложения).
2) Алгоритм / шаги (несколько пунктов).
3) Пример оформления, если уместно.

Если вы не уверены в точных номерах пунктов — прямо скажите:
«проверьте в официальном ГОСТе».
    `.trim();

    const payload = {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 800,
      temperature: 0.1
    };

    const response = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const txt = await response.text().catch(() => null);
      console.error('OpenAI error', response.status, txt);
      return res
        .status(502)
        .json({ error: 'LLM provider error', details: txt });
    }

    const data = await response.json();
    const answer =
      data.choices?.[0]?.message?.content ??
      'Ошибка: пустой ответ от модели';

    const suffix =
      '\n\n(Пожалуйста, при необходимости проверьте формулировки в официальном ГОСТе.)';
    const finalAnswer = (answer || '').trim() + suffix;

    // 4) увеличиваем счётчик использованных сообщений
    const updatedUser = await incrementMessagesUsed(user.id);

    return res.status(200).json({
      answer: finalAnswer,
      messages_used: updatedUser.messages_used,
      free_limit: FREE_LIMIT
    });
  } catch (err) {
    console.error('Server error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
