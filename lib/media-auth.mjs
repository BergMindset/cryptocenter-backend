// ГАРД СТАТУС-РУЧКИ (/api/media/status).
//
// Зачем отдельный модуль: ключ раньше проверялся из query (?key=…) прямо в маршруте.
// Query-строка оседает в логах DO, прокси и Referer — это дыра №3 карты ботов,
// подтверждённая на живом проде 01.08. Правильное место ключа — ЗАГОЛОВОК.
//
// ⚠️ ВРЕМЕННО принимаем и ?key= — мост Центра (app/api/media-status/route.ts) шлёт
// именно так. Порядок снятия: (1) этот PR на прод → (2) PR Центра на заголовок →
// (3) отдельным PR убрать ветку legacy отсюда. До шага 3 каждый вызов через query
// пишет warn в лог — по нему видно, что Центр ещё не переключился.
//
// fail-closed: нет MEDIA_STATUS_TOKEN в env → не пускаем НИКОГО (403), а не «всех».
import crypto from 'node:crypto'

const eq = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

// Достаём ключ по приоритету: заголовок → Bearer → (устаревшее) query.
export function readMediaKey(req) {
  const h = req?.headers?.['x-media-key']
  if (h) return { key: String(h), legacy: false }
  const auth = String(req?.headers?.authorization || '')
  if (auth.startsWith('Bearer ')) return { key: auth.slice(7), legacy: false }
  const q = req?.query?.key
  if (q) return { key: String(q), legacy: true }
  return { key: '', legacy: false }
}

export function mediaAuth(req, token) {
  if (!token) return { ok: false, reason: 'not_configured', legacy: false }
  const { key, legacy } = readMediaKey(req)
  if (!key || !eq(key, token)) return { ok: false, reason: 'forbidden', legacy }
  return { ok: true, reason: null, legacy }
}
