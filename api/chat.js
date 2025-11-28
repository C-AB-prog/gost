// api/chat.js
const {
  getOrCreateUser,
  incrementMessagesUsed,
  clearExpiredPremium
} = require('../db');

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
      return res
        .status(400)
        .json({ error: 'telegramId and message are required' });
    }

    const tgId = String(telegramId);

    // 1. Получаем пользователя
    let user = await getOrCreateUser(tgId);

    // 2. Проверяем премиум
    const now = new Date();
    let isPremium = false;
    if (user.is_premium && user.premium_until) {
      const until = new Date(user.premium_until);
      if (until > now) {
        isPremium = true;
      } else {
        user = await clearExpiredPremium(user.id);
      }
    }

    // 3. Проверяем лимит только если нет премиума
    if (!isPremium && user.messages_used >= FREE_LIMIT) {
      return res.status(403).json({
        error: 'limit_reached',
        message:
          'Ваши 3 бесплатных обращения к ЕСКД-ассистенту закончились. Оформите премиум, чтобы пользоваться без ограничений.',
        messages_used: user.messages_used,
        free_limit: FREE_LIMIT,
        is_premium: false
      });
    }

    // 4. System prompt
    const systemPrompt = `
Вы — эксперт по ЕСКД и стандартам ГОСТ, специализирующийся на оформлении конструкторской документации и смежных областях.

Стиль ответа:
- Пишите простым, живым, человеческим русским языком.
- Не используйте Markdown-разметку вовсе (никаких **, # и т.п.).
- Делайте структурированный ответ с короткими блоками.

Формат ответа:

1) Краткий вывод
Один-два коротких предложения по сути вопроса.

2) Алгоритм действий
1. ...
2. ...
3. ...

3) Рекомендуемые стандарты
По 1–2 ГОСТа в строке:
ГОСТ 2.301-68 — Форматы. Кратко, что регулирует.
ГОСТ 2.304-81 — Шрифты чертежные. Кратко, что регулирует.

Если вопрос не про ЕСКД, а про другие ГОСТы (продукты, упаковка и т.п.), подберите подходящие стандарты.

4) Что посмотреть в официальном ГОСТе
Какие разделы или пункты стоит открыть (без точных цитат). Если номер пункта не уверены — так и пишите, что нужно уточнить в официальном тексте.

5) Ссылки на официальные источники
По 2–4 строки вида:
ГОСТ 2.301-68: https://docs.cntd.ru/search?search=ГОСТ+2.301-68
ГОСТ 2.304-81: https://gostedu.ru/search?query=2.304-81

Можно использовать docs.cntd.ru, gostedu.ru, allgosts.ru, standartgost.ru.

Не выдумывайте несуществующие ГОСТы. Если сомневаетесь — честно пишите об этом.
    `.trim();

    const payload = {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 800,
      temperature: 0.15
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
      data.choices?.[0]?.message?.content ||
      'Ошибка: пустой ответ от модели';

    const suffix =
      '\n\nНапоминание: при серьёзном использовании обязательно перепроверьте формулировки в официальном тексте ГОСТ.';
    const finalAnswer = answer.trim() + suffix;

    // 5. Увеличиваем счётчик (даже у премиума — просто статистика)
    const updatedUser = await incrementMessagesUsed(user.id);

    return res.status(200).json({
      answer: finalAnswer,
      messages_used: updatedUser.messages_used,
      free_limit: FREE_LIMIT,
      is_premium: isPremium,
      premium_until: user.premium_until
    });
  } catch (err) {
    console.error('Server error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
