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

/**
 * === ЦЕНЗУРА (быстрый слой) ===
 * Можно расширять списки, но это уже неплохо режет мат и явное 18+.
 */
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

/**
 * === УМНОЕ ОПРЕДЕЛЕНИЕ "СЛИШКОМ ОБЩЕ" ===
 * На такие запросы мы не тратим модель, а выдаём хорошее уточнение.
 * Но если есть history — считаем контекст уже заданным и не придираемся.
 */
function isTooVague(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return true;
  if (words.length === 2 && t.length < 18) return true;
  if (t.length < 10) return true;
  return false;
}

// Простая эвристика по домену
function seemsEskd(text) {
  const t = String(text || '').toLowerCase();
  const keys = [
    'ескд','черт','чертёж','рамк','основн','надпис','штамп','формат','шрифт',
    'вид','разрез','сечен','спецификац','размер','допуск','шероховат','посадк','обозначен'
  ];
  return keys.some(k => t.includes(k));
}

function seemsProductOrLabel(text) {
  const t = String(text || '').toLowerCase();
  const keys = [
    'маркировк','упаковк','этикет','состав','срок год','условия хран','производит',
    'техрегламент','тр тс','тр еаэс','еас','пищевая ценность','масса нетто','гост р',
    'салфетк','майонез','кетчуп','напит','конфет','молок','сыр','колбас'
  ];
  return keys.some(k => t.includes(k));
}

/**
 * === Уточнялки (умные) ===
 */
function clarifyEskd(userText) {
  return [
    'Чтобы ответ был точным, уточню 2–3 вещи:',
    `1) Это чертёж детали или сборочный?`,
    `2) Формат листа (А4/А3/…) и ориентация?`,
    `3) Что именно нужно: рамка/основная надпись, шрифты, размеры/допуски, виды/разрезы, спецификация?`,
    '',
    `Напишите коротко в формате:`,
    `«${userText} — (деталь/сборка), формат А?, что сделать»`,
    '',
    'И я дам пошаговый алгоритм и список стандартов, которые реально пригодятся.'
  ].join('\n');
}

function clarifyProduct(userText) {
  return [
    'Понял. Чтобы не гадать, уточню по делу:',
    `1) Что это: салфетки сухие/влажные? (если влажные — косметические/гигиенические?)`,
    `2) Для какой территории: РФ/ЕАЭС?`,
    `3) Что нужно именно по маркировке: обязательные надписи на упаковке, состав/материал, условия хранения, изготовитель, знаки (ЕАС)?`,
    '',
    `Ответьте одной строкой, например:`,
    `«${userText} — влажные, для ЕАЭС, нужна маркировка на упаковке»`,
    '',
    'После этого дам: что обязательно указать + какие нормы открыть в официальных текстах.'
  ].join('\n');
}

function clarifyGeneric(userText) {
  return [
    'Уточню, чтобы попасть точно:',
    `Вы написали: "${userText}". Это про:`,
    '1) ЕСКД/чертежи (рамки, шрифты, виды/разрезы, размеры/допуски, спецификации)',
    '2) ГОСТ/ТР по продукту/упаковке/маркировке (этикетка, состав, срок годности, ЕАС и т.п.)',
    '3) Другое (опишите цель в 1–2 фразах: что оформить/проверить/получить)',
    '',
    'Ответьте цифрой и добавьте 1–2 детали — и я продолжу.'
  ].join('\n');
}

/**
 * Приводим history в безопасный формат (на случай мусора/слишком длинного)
 */
function sanitizeHistory(historyRaw) {
  if (!Array.isArray(historyRaw)) return [];
  const out = [];
  for (const m of historyRaw.slice(-10)) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'user' || m.role === 'assistant' ? m.role : null;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!role || !content) continue;
    // ограничим длину каждой реплики, чтобы не раздуть токены
    out.push({ role, content: content.slice(0, 1200) });
  }
  return out.slice(-8); // держим короткую память
}

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

    // 0) Цензура
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

    // 1) Пользователь
    let user = await getOrCreateUser(tgId);

    // 2) Премиум
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
        message: 'Ваши 3 бесплатных обращения закончились. Оформите премиум, чтобы пользоваться без ограничений.',
        messages_used: user.messages_used,
        free_limit: FREE_LIMIT,
        is_premium: false
      });
    }

    // 4) История (память контекста)
    const history = sanitizeHistory(historyRaw);

    // 5) Если запрос слишком общий и нет контекста — уточняем без модели
    // (Если есть history, обычно уже есть контекст — тогда не мешаем)
    const hasContext = history.some(m => m.role === 'user' && m.content.length > 10);
    if (!hasContext && isTooVague(rawText)) {
      let clarify = null;
      if (seemsEskd(rawText)) clarify = clarifyEskd(rawText);
      else if (seemsProductOrLabel(rawText)) clarify = clarifyProduct(rawText);
      else clarify = clarifyGeneric(rawText);

      return jsonOk(res, {
        answer: clarify,
        messages_used: user.messages_used,
        free_limit: FREE_LIMIT,
        is_premium: isPremium,
        premium_until: user.premium_until,
        needs_clarification: true
      });
    }

    // 6) Системный промпт “разум чертилы”
    // Здесь ключ: НЕ быть канцеляритом, а думать как инженер/нормоконтролёр.
    const systemPrompt = `
Ты — ЕСКД-ассистент уровня “нормоконтроль”: думаешь как опытный чертёжник/инженер и практик по маркировке/упаковке.
Твоя задача — дать результат, который можно реально применить.

Тон:
— дружелюбно, уверенно, по делу.
— без markdown-разметки (никаких **, #, списков со спецсимволами).
— короткие блоки, нормальная типографика (пустые строки допустимы).

Правило поведения:
1) Если данных мало или запрос неоднозначный:
   — СНАЧАЛА задай 2–5 уточняющих вопросов (только нужные).
   — Потом дай “предварительный ориентир” (что обычно применяют), чтобы человек уже понимал направление.
2) Если данных достаточно:
   — Дай итог сразу: “что делать” + “какие нормы” + “что открыть в тексте”.
3) Никогда не выдумывай стандарты. Если не уверен — так и напиши: “нужно уточнить по официальному тексту/реестру”.
4) Мат/18+ не поддерживаем — отвечай нейтрально и предлагай переформулировать.

Структура ответа (когда можно отвечать по существу):
1) Краткий вывод (1–2 предложения)
2) Что уточнить (если нужно) — отдельным блоком “Уточняющие вопросы”
3) Алгоритм действий (1. 2. 3.)
4) Нормативка (ГОСТ/ТР): по 1–2 в строке + зачем нужен
5) Что открыть в официальном тексте (разделы/пункты искать; если номер пункта не уверен — так и пиши)
6) Ссылки на поиск официальных текстов (2–4 строки)

Доменные подсказки (думай как эксперт):
— ЕСКД: первым делом выясняй тип документа (деталь/сборка), формат, что оформляем (рамка/штамп/шрифты/размеры/допуски/виды/спецификация).
— Маркировка/упаковка: выясняй тип товара (еда/косметика/быт/медицинское/химия), территория (ЕАЭС/РФ), формат упаковки, для кого, есть ли контакт с кожей/пищей, влажные/сухие, состав/материал.
— Для салфеток: важны тип (влажные/сухие), назначение (гигиенические/косметические/бытовые), состав пропитки (если влажные), материал основы, условия хранения, изготовитель, партия/дата, знаки обращения (ЕАС — если применимо).

Ссылки разрешены только как поисковые:
docs.cntd.ru/search?search=...
gostedu.ru/search?query=...
allgosts.ru
standartgost.ru
    `.trim();

    // 7) Собираем сообщения для модели: system + немного истории + текущий вопрос
    const messages = [{ role: 'system', content: systemPrompt }];

    // чтобы модель не “повторяла весь чат”, держим короткую память
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

    const suffix =
      '\n\nНапоминание: для реального оформления/производства обязательно сверяйтесь с официальными текстами стандартов.';
    const finalAnswer = answer.trim() + suffix;

    // 8) Счётчик: считаем только если был вызов модели (здесь был)
    const updatedUser = await incrementMessagesUsed(user.id);

    return jsonOk(res, {
      answer: finalAnswer,
      messages_used: updatedUser.messages_used,
      free_limit: FREE_LIMIT,
      is_premium: isPremium,
      premium_until: user.premium_until,
      // если модель сама задала вопросы — фронт просто покажет, но мы не ставим needs_clarification автоматически
      // needs_clarification: false
    });
  } catch (err) {
    console.error('Server error', err);
    return jsonErr(res, 500, 'SERVER_ERROR', 'Server error');
  }
};
