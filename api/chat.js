// api/chat.js
const {
  getOrCreateUser,
  incrementMessagesUsed,
  clearExpiredPremium
} = require('../db');

const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
const FREE_LIMIT = 3;

// ===== Helpers =====
function jsonOk(res, data) {
  return res.status(200).json({ ok: true, ...data });
}
function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, error: { code, message, ...extra } });
}

// ===== Censorship (simple & fast) =====
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

// ===== Domain heuristics =====
function seemsEskd(text) {
  const t = String(text || '').toLowerCase();
  const keys = [
    'ескд','черт','чертёж','рамк','основн','надпис','штамп','формат','шрифт',
    'вид','разрез','сечен','спецификац','размер','допуск','шероховат','посадк',
    'обозначен','позици','тех треб'
  ];
  return keys.some(k => t.includes(k));
}

function seemsLabeling(text) {
  const t = String(text || '').toLowerCase();
  const keys = [
    'маркировк','упаковк','этикет','состав','срок год','условия хран','производит',
    'импортер','изготовит','еас','тр тс','тр еаэс','безопасн','партия','дата изготов',
    'масса нетто','объем','штрихкод','гост', 'декларация', 'сертиф',
    // товары
    'салфетк','майонез','кетчуп','молок','сыр','колбас','напит','конфет','шампун','крем'
  ];
  return keys.some(k => t.includes(k));
}

function isTooVague(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return true;
  if (t.length < 10) return true;
  return false;
}

// ===== History sanitation =====
function sanitizeHistory(historyRaw) {
  if (!Array.isArray(historyRaw)) return [];
  const out = [];
  for (const m of historyRaw.slice(-12)) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'user' || m.role === 'assistant' ? m.role : null;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!role || !content) continue;
    out.push({ role, content: content.slice(0, 1200) });
  }
  return out.slice(-8);
}

// ===== Clarify flows with suggestions =====
function clarifyEskd(userText) {
  return {
    answer: [
      'Уточню пару деталей — и дам точный алгоритм по ЕСКД:',
      '1) Это чертёж детали или сборочный?',
      '2) Формат листа (А4/А3/…)?',
      '3) Что нужно: рамка/основная надпись, шрифты, размеры/допуски, виды/разрезы, спецификация?',
      '',
      'Можно ответить одним сообщением: «деталь, А3, нужна рамка и основная надпись».'
    ].join('\n'),
    suggestions: [
      'Деталь, А4 — рамка/штамп',
      'Деталь, А3 — шрифты',
      'Сборочный — спецификация',
      'Размеры/допуски',
      'Виды/разрезы/сечения'
    ]
  };
}

function clarifyLabeling(userText) {
  return {
    answer: [
      'Ок, по маркировке лучше уточнить 2–3 вещи — тогда попадём точно:',
      '1) Что за товар? (например: влажные/сухие салфетки; пищевая продукция; косметика и т.д.)',
      '2) Для какой территории: РФ/ЕАЭС?',
      '3) Что нужно именно: обязательные надписи на упаковке, состав/материал, условия хранения, знаки (ЕАС), требования к тексту/шрифту?',
      '',
      'Ответьте одной строкой, например: «влажные салфетки, ЕАЭС, нужна маркировка на упаковке».'
    ].join('\n'),
    suggestions: [
      'ЕАЭС — обязательные надписи',
      'Салфетки влажные — упаковка',
      'Салфетки сухие — упаковка',
      'Пищевая продукция — этикетка',
      'Косметика — маркировка'
    ]
  };
}

function clarifyGeneric(userText) {
  return {
    answer: [
      'Чтобы ответ был точным, уточню направление:',
      `Вы написали: "${userText}". Это про:`,
      '1) ЕСКД/чертежи',
      '2) ГОСТ/ТР для товара/упаковки/маркировки',
      '3) Другое (что именно нужно сделать/проверить?)',
      '',
      'Ответьте цифрой и добавьте 1–2 детали.'
    ].join('\n'),
    suggestions: ['1 (ЕСКД)', '2 (Маркировка)', '3 (Другое)']
  };
}

// ===== Main handler =====
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return jsonErr(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
  if (!OPENAI_KEY) {
    return jsonErr(res, 500, 'CONFIG_ERROR', 'OPENAI_KEY is not set');
  }

  try {
    const { telegramId, message: userMessage, history: historyRaw } = req.body || {};
    if (!telegramId || !userMessage) {
      return jsonErr(res, 400, 'VALIDATION_ERROR', 'telegramId and message are required');
    }

    const tgId = String(telegramId);
    const rawText = String(userMessage).trim();

    // 0) Censorship
    const banned = containsBanned(rawText);
    if (banned.hitProf || banned.hitSex) {
      return jsonOk(res, {
        answer: [
          'Я не могу помогать с матом или 18+ контентом.',
          'Переформулируйте запрос нейтрально — и я помогу по сути.'
        ].join('\n'),
        messages_used: 0,
        free_limit: FREE_LIMIT,
        is_premium: false,
        premium_until: null,
        blocked: true
      });
    }

    // 1) User
    let user = await getOrCreateUser(tgId);

    // 2) Premium check
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

    // 3) Free limit
    if (!isPremium && user.messages_used >= FREE_LIMIT) {
      return res.status(403).json({
        ok: false,
        error: { code: 'LIMIT_REACHED', message: 'limit_reached' },
        message: 'Ваши 3 бесплатных обращения закончились. Оформите премиум, чтобы пользоваться без ограничений.',
        messages_used: user.messages_used,
        free_limit: FREE_LIMIT,
        is_premium: false
      });
    }

    // 4) History memory
    const history = sanitizeHistory(historyRaw);
    const hasContext = history.some(m => m.role === 'user' && m.content.length > 12);

    // 5) Cheap clarify (no model) ONLY if no context and too vague
    if (!hasContext && isTooVague(rawText)) {
      let pack;
      if (seemsEskd(rawText)) pack = clarifyEskd(rawText);
      else if (seemsLabeling(rawText)) pack = clarifyLabeling(rawText);
      else pack = clarifyGeneric(rawText);

      return jsonOk(res, {
        answer: pack.answer,
        suggestions: pack.suggestions,
        needs_clarification: true,
        messages_used: user.messages_used,
        free_limit: FREE_LIMIT,
        is_premium: isPremium,
        premium_until: user.premium_until
      });
    }

    // 6) System prompt: "разум чертилы" + практик маркировки
    const systemPrompt = `
Ты — ЕСКД-ассистент уровня “нормоконтроль”: опытный чертёжник/инженер + практик по маркировке/упаковке.
Пиши как человек: дружелюбно, уверенно и по делу.
НЕ используй Markdown-разметку (никаких **, #, таблиц markdown).
Разрешены обычные списки с "1) 2) 3)" и короткие блоки.

Главная логика:
— Если данных достаточно: дай готовый результат (что делать + какие нормы + что открыть в тексте).
— Если данных мало: задай 2–5 точных вопросов (не общих), затем дай предварительный ориентир.
— Не выдумывай стандарты. Если не уверен — так и скажи и предложи, где проверить.

Формат ответа, когда можно отвечать по существу:
1) Краткий вывод (1–2 предложения)
2) Уточняющие вопросы (если нужно)
3) Алгоритм действий (1) 2) 3))
4) Нормативка (ГОСТ/ТР): по 1–2 в строке + зачем
5) Что открыть в официальном тексте (разделы/пункты; если не уверен в пункте — так и напиши)
6) Ссылки на поиск официальных текстов (2–4 строки, только поисковые ссылки)

Подсказки по доменам:
— ЕСКД: выясни (деталь/сборка), формат, что оформляем (рамка/штамп/шрифты/размеры/допуски/виды/спецификация).
— Маркировка: выясни тип товара (еда/косметика/быт/мед/химия), территория (ЕАЭС/РФ), упаковка, контакт с кожей/пищей, состав/материал.
— Салфетки: важно (влажные/сухие), назначение (гигиена/косметика/быт), материал основы, если влажные — состав пропитки, условия хранения, изготовитель, партия/дата, обязательные надписи/знаки.
    `.trim();

    // 7) Compose messages
    const messages = [{ role: 'system', content: systemPrompt }];

    // short memory
    for (const m of history) messages.push(m);
    messages.push({ role: 'user', content: rawText });

    const payload = {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      max_tokens: 950,
      temperature: 0.25
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

    // 8) Light post-processing: if model asked questions, offer quick buttons
    // (эвристика: если есть "Уточняющие вопросы" — добавим 3–5 подсказок)
    let suggestions = null;
    const lower = answer.toLowerCase();
    if (lower.includes('уточняющ') || lower.includes('уточню') || lower.includes('уточните')) {
      // общий набор: помогает пользователю отвечать быстро
      suggestions = [
        'Для ЕАЭС',
        'Для РФ',
        'Влажные',
        'Сухие',
        'Нужна маркировка на упаковке'
      ];
      if (seemsEskd(rawText)) {
        suggestions = [
          'Деталь, А4',
          'Деталь, А3',
          'Сборочный',
          'Нужна рамка/штамп',
          'Нужны шрифты'
        ];
      }
    }

    const suffix =
      '\n\nНапоминание: для реального оформления/производства обязательно сверяйтесь с официальными текстами стандартов.';
    const finalAnswer = answer.trim() + suffix;

    const updatedUser = await incrementMessagesUsed(user.id);

    return jsonOk(res, {
      answer: finalAnswer,
      suggestions,
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
