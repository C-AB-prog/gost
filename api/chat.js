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
      return res
        .status(400)
        .json({ error: 'telegramId and message are required' });
    }

    const tgId = String(telegramId);

    // 1. Получаем или создаём пользователя
    const user = await getOrCreateUser(tgId);

    // 2. Проверяем лимит
    if (user.messages_used >= FREE_LIMIT) {
      return res.status(403).json({
        error: 'limit_reached',
        message:
          'Ваши 3 бесплатных обращения к ЕСКД-ассистенту закончились. В ближайшее время появится подписка.',
        messages_used: user.messages_used,
        free_limit: FREE_LIMIT
      });
    }

    // 3. System prompt с аккуратным стилем без Markdown
    const systemPrompt = `
Вы — эксперт по ЕСКД и стандартам ГОСТ, специализирующийся на оформлении конструкторской документации и смежных областях.

Стиль ответа:
- Пишите простым, живым, человеческим русским языком.
- Не используйте Markdown-разметку вообще (никаких символов **, -, # и т.п.).
- Делайте структурированный, но визуально чистый ответ с короткими блоками.

Формат ответа (строго придерживайтесь этой структуры):

1) Краткий вывод
Один-два коротких предложения по сути вопроса.

2) Алгоритм действий
Короткий, практичный список шагов в формате:
1. ...
2. ...
3. ...

3) Рекомендуемые стандарты
Перечислите 2–4 ГОСТа, каждый в отдельной строке:
ГОСТ 2.301-68 — Форматы. Кратко, что регулирует в контексте вопроса.
ГОСТ 2.304-81 — Шрифты чертежные. Кратко, что регулирует.
Если вопрос не про ЕСКД, но про ГОСТы в других областях (например, продукты, упаковка и т.п.), укажите соответствующие ГОСТы по теме вопроса.

4) Что посмотреть в официальном ГОСТе
Кратко перечислите, какие разделы или пункты стоит открыть (без точных цитат). Если вы не уверены в номере пункта, честно напишите, что точный пункт нужно уточнить в официальном тексте.

5) Ссылки на официальные источники
Дайте 2–4 строки такого вида:
ГОСТ 2.301-68: https://docs.cntd.ru/search?search=ГОСТ+2.301-68
ГОСТ 2.304-81: https://gostedu.ru/search?query=2.304-81
Можно использовать сайты:
docs.cntd.ru, gostedu.ru, allgosts.ru, standartgost.ru.

Дополнительные правила:
- Не выдумывайте несуществующие ГОСТы. Если сомневаетесь — так и напишите.
- Отвечайте по сути и не растягивайте текст.
- Если вопрос слишком общий (например, просто «майонез»), аккуратно попросите уточнение, но всё равно дайте полезную базу: что обычно регулируется ГОСТами в этой теме и какие стандарты смотрят.
    `.trim();

    // 4. Запрос к OpenAI
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

    // 5. Добавляем короткое напоминание
    const suffix =
      '\n\nНапоминание: при серьёзном использовании обязательно перепроверьте формулировки в официальном тексте ГОСТ.';
    const finalAnswer = answer.trim() + suffix;

    // 6. Увеличиваем счётчик
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
