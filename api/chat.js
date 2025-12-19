// api/chat.js
const {
  getOrCreateUser,
  incrementMessagesUsed,
  clearExpiredPremium
} = require('../db');

const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
const FREE_LIMIT = 3;

function jsonOk(res, data) {
  return res.status(200).json({ ok: true, ...data });
}
function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, error: { code, message, ...extra } });
}

// простая цензура (расширяй список под себя)
const PROFANITY = [
  'бля', 'сука', 'хуй', 'хуе', 'пизд', 'еба', 'ёба', 'манда', 'шлюх', 'мудак', 'гондон'
];
const SEXUAL_18 = [
  'порно', 'секс', 'эрот', 'аналь', 'ораль', 'минет', 'мастурб', 'фетиш', 'инцест'
];

function containsBanned(text) {
  const t = String(text || '').toLowerCase();
  const hitProf = PROFANITY.some(w => t.includes(w));
  const hitSex = SEXUAL_18.some(w => t.includes(w));
  return { hitProf, hitSex };
}

// эвристика “слишком общий”
function isTooVague(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return true;
  if (words.length === 2 && t.length < 18) return true;
  if (t.length < 10) return true;
  return false;
}

function seemsProduct(text) {
  const t = String(text || '').toLowerCase();
  const keys = [
    'майонез', 'кетчуп', 'сметан', 'молок', 'хлеб', 'колбас', 'сыр',
    'упаковк', 'этикет', 'маркировк', 'состав', 'пище'
  ];
  return keys.some(k => t.includes(k));
}

function seemsEskd(text) {
  const t = String(text || '').toLowerCase();
  const keys = [
    'ескд', 'черт', 'чертёж', 'рамк', 'основн', 'надпис', 'формат',
    'штамп', 'шрифт', 'разрез', 'сечен', 'спецификац', 'допуск', 'размер'
  ];
  return keys.some(k => t.includes(k));
}

function productClarifyPrompt(userText) {
  return [
    'Уточню, чтобы попасть точно.',
    '',
    `Вы написали: "${userText}". Что именно нужно?`,
    '1) Упаковка и маркировка (этикетка: состав, срок годности, условия хранения, ЕАС и т.п.)',
    '2) Требования к составу/качеству (показатели, допустимые отклонения, органолептика)',
    '3) Безопасность и техрегламенты ЕАЭС (что обязательно соблюдать производителю)',
    '4) Условия хранения/транспортировки (температуры, тара, срок)',
    '5) Методы испытаний/контроль качества (какие анализы и что проверяют)',
    '',
    'Ответьте цифрой (1–5) и уточните: продукт для РФ/ЕАЭС? промышленный или домашний?'
  ].join('\n');
}

function eskdClarifyPrompt(userText) {
  return [
    'Понял. Уточню пару деталей — и дам точный алгоритм и ГОСТы.',
    '',
    `Вы написали: "${userText}". Это про что именно?`,
    '1) Форматы/рамка/основная надпись',
    '2) Шрифты и размеры текста',
    '3) Виды/разрезы/сечения',
    '4) Размеры и допуски (нанесение, стрелки, выносные линии)',
    '5) Спецификация/ведомости/обозначения',
    '',
    'Ответьте цифрой и скажите: это чертёж детали или сборочный? и какой формат листа (А4/А3/…)?'
  ].join('\n');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return jsonErr(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }

  if (!OPENAI_KEY) {
    return jsonErr(res, 500, 'CONFIG_ERROR', 'OPENAI_KEY is not set');
  }

  try {
    const { telegramId, message: userMessage } = req.body || {};
    if (!telegramId || !userMessage) {
      return jsonErr(res, 400, 'VALIDATION_ERROR', 'telegramId and message are required');
    }

    const tgId = String(telegramId);
    const rawText = String(userMessage).trim();

    // 0) Цензура (мат/18+)
    const banned = containsBanned(rawText);
    if (banned.hitProf || banned.hitSex) {
      return jsonOk(res, {
        answer: [
          'Я не могу помогать с матом или 18+ контентом.',
          'Если хотите — переформулируйте запрос нейтрально, и я помогу по сути.'
        ].join('\n'),
        messages_used: 0,
        free_limit: FREE_LIMIT,
        is_premium: false,
        premium_until: null,
        blocked: true
      });
    }

    // 1) Получаем пользователя
    let user = await getOrCreateUser(tgId);

    // 2) Проверяем премиум
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

    // 3) Лимит
    if (!isPremium && user.messages_used >= FREE_LIMIT) {
      return res.status(403).json({
        ok: false,
        error: { code: 'LIMIT_REACHED', message: 'limit_reached' },
        message:
          'Ваши 3 бесплатных обращения закончились. Оформите премиум, чтобы пользоваться без ограничений.',
        messages_used: user.messages_used,
        free_limit: FREE_LIMIT,
        is_premium: false
      });
    }

    // 4) Если запрос слишком общий — уточняем, не вызывая модель
    if (isTooVague(rawText)) {
      let clarify = null;
      if (seemsProduct(rawText)) clarify = productClarifyPrompt(rawText);
      else if (seemsEskd(rawText)) clarify = eskdClarifyPrompt(rawText);
      else {
        clarify = [
          'Хочу уточнить, чтобы ответ был точным.',
          '',
          `Вы написали: "${rawText}". Это про:`,
          '1) ЕСКД/чертежи (рамки, шрифты, виды, размеры, спецификации)',
          '2) ГОСТы на продукт/упаковку/маркировку',
          '3) Другое (опишите цель в 1–2 фразах: что оформить/проверить/получить)',
          '',
          'Ответьте цифрой и добавьте 1–2 детали (для чего это нужно).'
        ].join('\n');
      }

      return jsonOk(res, {
        answer: clarify,
        messages_used: user.messages_used,
        free_limit: FREE_LIMIT,
        is_premium: isPremium,
        premium_until: user.premium_until,
        needs_clarification: true
      });
    }

    // 5) System prompt
    const systemPrompt = `
Вы — дружелюбный, практичный эксперт по ЕСКД и ГОСТ (в т.ч. ГОСТы для продуктов/упаковки/маркировки).
Ваша цель — быстро дать полезный результат и, если данных не хватает, задать наводящие вопросы.

Стиль:
- Пишите живо и по делу, без воды.
- Не используйте Markdown-разметку (никаких **, # и т.п.).
- Структурируйте ответ короткими блоками.

Правила:
- Если запрос неоднозначный: сначала задайте 2–4 уточняющих вопроса, потом дайте предварительный ориентир.
- Не выдумывайте несуществующие ГОСТы. Если не уверены — честно напишите, что нужно уточнить по официальному реестру/тексту.
- Если тема не про ЕСКД: подбирайте релевантные ГОСТ/ТР ЕАЭС, но обозначайте границы уверенности.
- Мат и 18+ не поддерживаем: отвечайте нейтрально и предлагайте переформулировать.

Формат ответа (если данных достаточно):
1) Краткий вывод
2) Алгоритм действий (1. 2. 3.)
3) Рекомендуемые стандарты (по 1–2 стандарта в строке + кратко)
4) Что открыть в официальном тексте (какие разделы/пункты искать)
5) Ссылки на поиск официальных текстов (2–4 строки; docs.cntd.ru и аналоги)

Если данных НЕ хватает:
Сначала блок "Уточняющие вопросы", затем "Предварительный ориентир".
    `.trim();

    const payload = {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawText }
      ],
      max_tokens: 900,
      temperature: 0.2
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => null);
      console.error('OpenAI error', response.status, txt);
      return jsonErr(res, 502, 'LLM_PROVIDER_ERROR', 'LLM provider error', { details: txt });
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || 'Ошибка: пустой ответ от модели';

    const suffix =
      '\n\nНапоминание: для реального оформления/производства обязательно сверяйтесь с официальными текстами стандартов.';
    const finalAnswer = answer.trim() + suffix;

    // считаем сообщение только если реально ответили моделью
    const updatedUser = await incrementMessagesUsed(user.id);

    return jsonOk(res, {
      answer: finalAnswer,
      messages_used: updatedUser.messages_used,
      free_limit: FREE_LIMIT,
      is_premium: isPremium,
      premium_until: user.premium_until
    });
  } catch (err) {
    console.error('Server error', err);
    return jsonErr(res, 500, 'SERVER_ERROR', 'Server error');
  }
};
