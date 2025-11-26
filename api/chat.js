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

    // 2. Проверка лимита (для всех, и Telegram, и браузерных local-xxx)
    if (user.messages_used >= FREE_LIMIT) {
      return res.status(403).json({
        error: 'limit_reached',
        message:
          'Ваши 3 бесплатных обращения к ЕСКД-ассистенту закончились. В ближайшее время появится подписка.',
        messages_used: user.messages_used,
        free_limit: FREE_LIMIT
      });
    }

    // 3. System prompt про ЕСКД/ГОСТ
    const systemPrompt = `
Вы — эксперт по ЕСКД и стандартам ГОСТ, специализирующийся на оформлении конструкторской документации.

ВАША ЦЕЛЬ — давать точные, практичные, структурированные ответы с обязательной привязкой к действующим ГОСТам и с корректными ссылками на официальные открытые источники стандартов.

ПРАВИЛА РАБОТЫ:

1. Пишите по-русски, предельно ясно и практично. Минимум воды, максимум пользы.
2. ВСЕГДА указывайте:
   • номер ГОСТа,
   • его официальное название,
   • что именно он регулирует в контексте вопроса пользователя.
3. Если есть сомнения — НЕ ВЫДУМЫВАЙТЕ ГОСТЫ И ПУНКТЫ.
   Пишите: «точный пункт нужно проверить в официальном тексте ГОСТ».
4. В каждом ответе ОБЯЗАТЕЛЬНО делайте блок **"Ссылки на официальные источники"**.
   Используйте ТОЛЬКО эти ресурсы:
   • https://docs.cntd.ru — официальная правовая база нормативных документов РФ  
   • https://gostedu.ru — портал по ЕСКД и СПДС  
   • https://allgosts.ru — открытая библиотека ГОСТов  
   • https://standartgost.ru — федеральный реестр ГОСТ  
   Формат ссылки:
   «ГОСТ 2.301-68: https://docs.cntd.ru/search?search=ГОСТ+2.301-68»
5. Если в вопросе не хватает данных — уточните, что нужно.
6. Используйте Markdown.

СТРОГИЙ ФОРМАТ ОТВЕТА:

**1) Краткий вывод (1–2 предложения)**  
— Самая суть вопроса.

**2) Пошаговый алгоритм действий**  
- Шаг 1: ...  
- Шаг 2: ...  
- Шаг 3: ...  

**3) Рекомендуемые стандарты**  
- **ГОСТ ХХХХ–ХХ — «Название».** Что регулирует.  
- **ГОСТ YYYY–YY — «Название».** Пояснение.  

**4) Что проверить в официальном ГОСТе**  
— Пункты, разделы, таблицы, которые нужно посмотреть.  
Если не уверены — «Проверьте точную формулировку в официальном тексте ГОСТ».

**5) Ссылки на официальные источники**  
(всегда минимум 2–4 конкретных ссылки, созданных через поиск)  
- ГОСТ 2.301-68 — https://docs.cntd.ru/search?search=ГОСТ+2.301-68  
- ГОСТ 2.104-2006 — https://allgosts.ru/search?search=2.104-2006  
- ГОСТ 2.304-81 — https://gostedu.ru/search?query=2.304-81  
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

    const suffix =
      '\n\n(Перед использованием обязательно проверьте формулировки в официальном тексте ГОСТ.)';
    const finalAnswer = answer.trim() + suffix;

    // 5. Увеличиваем счётчик для этого пользователя
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
