// Контент-фабрика · АВТОМАТ-КОМПЛАЕНС («робот-ОТК»). Проверяет пост ДО ревью основателя.
// Правила GLASS ENGINE: запретные слова, обязательный дисклеймер, метки «model», ручной claim,
// и главное — КАЖДАЯ цифра поста должна прослеживаться в реестре фактов (facts.mjs). Брак = назад в переделку.
import { allowedNumbers, modelValues } from './facts.mjs'

// Запретные слова (RU+EN), поиск по границам слова, регистронезависимо.
// guarantee/гарантия — отдельно (нельзя ловить «not guaranteed / не гарантируется» — это дисклеймер).
const BANNED = [
  'risk-free', 'risk free', 'passive income', 'to the moon', 'hurry', 'last chance',
  'без риска', 'пассивный доход', 'успей', 'последний шанс',
]
// Требуемый дисклеймер (одна из форм).
const DISCLAIMER = [/not investment advice/i, /не является финансовой рекомендацией/i, /not financial advice/i]
// Контекст доходности — рядом должен стоять «model».
const YIELD_CTX = /(apy|apr|annual|годовых|доходн|yield|return)/i
const MODEL_LABEL = /(model|модельн|from fund accounting|из учёта фонда|illustrativ|иллюстратив)/i
// Контекст claim (TerraSim) — должен быть «manual/ручн», не «auto-withdraw/автовывод».
const CLAIM_CTX = /(claim|клейм|reinvest|реинвест)/i
const MANUAL_OK = /(manual|ручн|press.*24|раз в 24|once per 24|\/24h)/i
const AUTO_BAD = /(auto[- ]?withdraw|автовывод|withdraws? automatically|автоматическ.{0,12}вывод)/i

/** Извлечь числовые значения из текста (проценты, $-суммы, десятичные, целые). */
function extractNumbers(text) {
  const found = new Map() // key -> {norm, raw}
  const push = (norm, raw) => { if (Number.isFinite(norm)) found.set(norm + '|' + raw, { norm, raw }) }
  // проценты: 104%, ~39.5%, 2.5%
  for (const m of text.matchAll(/(~?\s*)(\d+(?:\.\d+)?)\s*%/g)) push(+m[2], m[0].trim())
  // $-суммы с суффиксом: $5.5M, $2,451,100, $1B, $707, $2,329
  for (const m of text.matchAll(/\$\s?([\d,]+(?:\.\d+)?)\s?([MBK])?/gi)) {
    let n = parseFloat(m[1].replace(/,/g, ''))
    const suf = (m[2] || '').toUpperCase()
    if (suf === 'M') n *= 1e6; else if (suf === 'B') n *= 1e9; else if (suf === 'K') n *= 1e3
    push(n, m[0].trim())
  }
  // голые десятичные ЦЕЛИКОМ (0.902, 1.29) — не резать на части; не после $ (те уже взяты)
  for (const m of text.matchAll(/(?<![$\d.])\d+\.\d+(?![.\d%])/g)) push(parseFloat(m[0]), m[0])
  // голые целые с группами / 2+ цифры — НЕ часть десятичного и НЕ часть $-суммы (lookbehind/ahead)
  for (const m of text.matchAll(/(?<![$\d.,])\b(\d{1,3}(?:,\d{3})+|\d{2,})\b(?![.\d%])/g)) {
    push(parseFloat(m[1].replace(/,/g, '')), m[1])
  }
  return [...found.values()]
}

// «Бытовые» числа, которые не обязаны быть в реестре (даты, годы, номера, мелочь).
const NOISE = new Set([2022, 2023, 2024, 2025, 2026, 5, 24, 3, 7, 30, 20, 40, 50, 60, 100])

/**
 * Проверить пост. Возвращает { pass, level, violations:[{rule, severity, detail}] }.
 * severity: 'block' (не пускать) | 'warn' (показать основателю).
 */
export function checkPost(text, facts, opts = {}) {
  const v = []
  const low = ' ' + text.toLowerCase() + ' '

  // 1) запретные слова — block
  for (const w of BANNED) {
    const re = new RegExp('(^|[^\\p{L}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}])', 'iu')
    if (re.test(low)) v.push({ rule: 'banned-word', severity: 'block', detail: `запретное слово: «${w}»` })
  }
  // 1b) guarantee/гарантия как ОБЕЩАНИЕ — block, но НЕ «not guaranteed / не гарантируется» (дисклеймер)
  for (const m of text.matchAll(/\b(guarante\w*|гаранти\w*)\b/giu)) {
    const before = text.slice(Math.max(0, m.index - 12), m.index).toLowerCase()
    if (!/\b(not|no|без|не)\s*$/.test(before)) v.push({ rule: 'banned-word', severity: 'block', detail: `слово-обещание: «${m[0]}»` })
  }

  // 2) дисклеймер — block, если нет
  if (!DISCLAIMER.some((re) => re.test(text)))
    v.push({ rule: 'no-disclaimer', severity: 'block', detail: 'нет дисклеймера «Not investment advice / Не является финансовой рекомендацией»' })

  // 3) доходность без метки «model» — block
  if (YIELD_CTX.test(text) && /\d+(\.\d+)?\s*%/.test(text) && !MODEL_LABEL.test(text))
    v.push({ rule: 'model-label', severity: 'block', detail: 'есть % доходности, но нет метки «model figure / модельная»' })

  // 4) claim: если про claim/reinvest — должно быть «ручной», и НЕ «автовывод»
  if (CLAIM_CTX.test(text)) {
    if (AUTO_BAD.test(text)) v.push({ rule: 'claim-auto', severity: 'block', detail: 'claim описан как автоматический — он РУЧНОЙ (раз в 24ч)' })
    else if (!MANUAL_OK.test(text)) v.push({ rule: 'claim-manual', severity: 'warn', detail: 'упомянут claim/reinvest, но не сказано, что claim ручной (раз в 24ч)' })
  }

  // 5) прослеживаемость цифр — каждая цифра должна быть в реестре (иначе «выдуманная»)
  const allowed = allowedNumbers(facts)
  const models = modelValues(facts)
  const nums = extractNumbers(text)
  const unverified = []
  for (const { norm, raw } of nums) {
    if (NOISE.has(norm)) continue
    // допуск ±0.5% на округления модельных примеров
    const ok = allowed.has(norm) || [...allowed].some((a) => a !== 0 && Math.abs((a - norm) / a) < 0.01)
    if (!ok) unverified.push(raw)
    // модельное число должно стоять рядом с меткой model где-то в тексте
    if (models.has(norm) && !MODEL_LABEL.test(text)) v.push({ rule: 'model-unlabeled', severity: 'warn', detail: `модельная цифра ${raw} без метки «model»` })
  }
  if (unverified.length)
    v.push({ rule: 'unverified-number', severity: 'block', detail: `цифры не из реестра фактов (возможно выдуманные): ${[...new Set(unverified)].join(', ')}` })

  const blocks = v.filter((x) => x.severity === 'block')
  return {
    pass: blocks.length === 0,
    level: blocks.length ? 'block' : v.length ? 'warn' : 'clean',
    violations: v,
    checkedNumbers: nums.length,
    centerUp: facts._centerUp,
  }
}
