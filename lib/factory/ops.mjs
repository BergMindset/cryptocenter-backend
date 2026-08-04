// MEDIA OS · ШТАБ ОПЕРАЦИЙ (задания операторам) — единый источник заданий для панели Центра.
// Спека: .claude/marketing/outreach-cabinet-spec.md
//
// ГЛАВНОЕ АРХИТЕКТУРНОЕ ПРАВИЛО (не обсуждается): ОДНА ДВЕРЬ ПУБЛИКАЦИИ.
// Панель Центра может: создать задание · отправить черновик на ОТК и превью основателю.
// Панель НЕ МОЖЕТ публиковать: approve физически живёт только в кнопке Telegram под HMAC-подписью
// (owner-chat). Вторая кнопка публикации в другом периметре = второй способ выпустить текст наружу,
// а инвариант «0 публикаций мимо кнопки» держится ровно до тех пор, пока дверь одна.
//
// ГРАНИЦА ЦЕЛИ: цель задания — ТОЛЬКО наш собственный канал из реестра Media OS.
// Личка постороннего / чужой чат отбиваются здесь, на приёме, с явной причиной (см. validateTarget).

import { ACCOUNTS } from './registry.mjs'
import { POLICY } from './outreach.mjs'

export const OPS_AS_OF = '2026-08-03'

// Состояния задания. published/rejected выставляются ТОЛЬКО из publish/reject-хэндлеров кнопки.
export const STATES = ['queued', 'drafting', 'compliance', 'awaiting_button', 'published', 'rejected']

export const TARGET_KINDS = {
  'own-channel': { allowed: true, note: 'наш канал/аккаунт из реестра Media OS' },
  'dm-stranger': { allowed: false, note: 'личка постороннего — запрещено (массовые/непрошеные ЛС)' },
  'foreign-chat': { allowed: false, note: 'чужой чат — запрещено (скоординированный заход с промо)' },
}

/** Цель разрешена, только если это наш аккаунт из реестра. Возвращает {ok, reason, account}. */
export function validateTarget(target, targetKind = 'own-channel') {
  const kind = TARGET_KINDS[targetKind]
  if (!kind) return { ok: false, reason: `неизвестный тип цели «${targetKind}»` }
  if (!kind.allowed) return { ok: false, reason: `запрещено политикой: ${kind.note}` }
  const t = String(target || '').trim().toLowerCase()
  if (!t) return { ok: false, reason: 'цель не указана' }
  const acc = ACCOUNTS.find(
    (a) => (a.handle && a.handle.toLowerCase() === t) || (a.url && a.url.toLowerCase() === t),
  )
  if (!acc) return { ok: false, reason: `«${target}» не найден в реестре Media OS: задание можно ставить только на наш собственный канал` }
  if (acc.status === 'Not Registered' || acc.status === 'Planned')
    return { ok: false, reason: `канал «${target}» ещё не зарегистрирован (статус ${acc.status})` }
  return { ok: true, reason: null, account: acc }
}

export function opsPolicy() {
  return {
    ...POLICY,
    singlePublishDoor: 'публикация только кнопкой в Telegram (HMAC, owner-chat); панель заданий не публикует',
    allowedTargetKinds: Object.entries(TARGET_KINDS).filter(([, v]) => v.allowed).map(([k]) => k),
    forbiddenTargetKinds: Object.entries(TARGET_KINDS).filter(([, v]) => !v.allowed).map(([k, v]) => ({ kind: k, why: v.note })),
  }
}

export function rowToTask(r) {
  return {
    id: r.id,
    theme: r.theme,
    brief: r.brief,
    target: r.target,
    targetKind: r.target_kind,
    operator: r.operator,
    language: r.language,
    format: r.format,
    state: r.state,
    draft: r.draft || null,
    draftPostId: r.draft_post_id || null, // id поста фабрики = связь с превью и кнопкой
    compliance: r.compliance || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
