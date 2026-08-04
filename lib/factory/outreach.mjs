// MEDIA OS · СЕКЦИЯ «ДИСТРИБУЦИЯ И АДРЕСНАЯ РАБОТА» (outreach) для панели Центра.
// Спека: .claude/marketing/outreach-cabinet-spec.md (03.08).
//
// Что это: «армия агентов» в легальном виде — основатель задаёт ТЕМУ, агенты (роли, а не фейк-люди)
// готовят адаптации, ОТК проверяет, кнопка основателя публикует веером.
//
// Чего здесь НЕТ и не будет (красные линии §0 спеки): множественные аккаунты-двойники,
// массовые непрошеные ЛС, скоординированный заход в чужие чаты, скрытое промо без раскрытия.
// Эти запреты отдаются машинно в policy.forbidden — панель Центра показывает их пользователю,
// чтобы правило жило в интерфейсе, а не только в документе.
//
// Fail-closed по данным: чего нет (listening-API) — supported:false + причина, НЕ выдуманный список.

import { ACCOUNTS } from './registry.mjs'

export const OUTREACH_AS_OF = '2026-08-03'

export const POLICY = {
  forbidden: [
    'аккаунты-двойники, изображающие независимых людей (астротурфинг)',
    'массовые непрошеные личные сообщения',
    'скоординированный заход нескольких аккаунтов в чужие чаты с промо',
    'скрытое промо без раскрытия связи с брендом',
  ],
  required: [
    'публикация и любое исходящее сообщение — только по кнопке основателя',
    'каждая цифра из реестра фактов, с датой; оценки помечены «модельная»',
    'раскрытие бренда в каждом промо-касании',
    'одно касание на контакт, персонально, отправляет человек',
  ],
}

// Роли агентов. publishes:true — роль публикует от лица РЕАЛЬНОГО аккаунта из реестра.
const ROLES = [
  { role: 'broadcast', publishes: true, does: 'готовит посты в наши каналы по заданной теме' },
  { role: 'community', publishes: true, does: 'отвечает на упоминания и вопросы о нас' },
  { role: 'founder-voice', publishes: true, does: 'готовит текст от лица основателя (публикует он)' },
  { role: 'research', publishes: false, does: 'собирает факты и источники под тему' },
  { role: 'compliance', publishes: false, does: 'ОТК: цифры, обещания, дисклеймеры' },
  { role: 'localization', publishes: false, does: 'адаптация RU↔EN под культуру площадки' },
]

// Публикующие агенты собираются ИЗ РЕЕСТРА: агент без реального аккаунта не существует.
function publishingAgents() {
  const live = ACCOUNTS.filter((a) => a.status === 'Confirmed' || a.status === 'Needs Verification')
  return live.map((a) => ({
    key: `${a.brand || 'unassigned'}:${a.platform}`.toLowerCase().replace(/\s+/g, '-'),
    role: a.brand === 'Andrej AI' ? 'founder-voice' : 'broadcast',
    brand: a.brand,
    platform: a.platform,
    handle: a.handle,
    publishes: true,
    identified: true, // непубличных/поддельных персон в системе нет по дизайну
    status: a.status,
    automation: a.automationStatus,
  }))
}

/**
 * Слепок секции. Кампании/касания появятся с первой заданной темой — до этого честно пусто.
 * inbound (слушание упоминаний) требует API площадок: пока supported:false с причиной.
 */
export function buildOutreach() {
  const agents = [
    ...publishingAgents(),
    ...ROLES.filter((r) => !r.publishes).map((r) => ({
      key: `system:${r.role}`, role: r.role, brand: null, platform: null, handle: null,
      publishes: false, identified: true, status: 'active', automation: 'pipeline',
    })),
  ]
  const campaigns = [] // заполнится при первой теме от основателя (через фабрику: тема → адаптации → кнопка)
  const outreachItems = []
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    dataAsOf: OUTREACH_AS_OF,
    source: 'media-backend',
    policy: POLICY,
    roles: ROLES,
    agents,
    campaigns,
    inbound: {
      supported: false,
      reason: 'слушание упоминаний требует API площадок: прямой X API не покупаем (красная линия), VK/TG — после ключей',
      items: [],
    },
    outreach: {
      items: outreachItems,
      rules: { oneTouchPerContact: true, personalOnly: true, senderIsHuman: true, sourcesAllowed: ['входящий лид (сам оставил контакт)', 'публичный партнёрский контакт', 'ответ на прямой вопрос'] },
    },
    counters: {
      agents: agents.length,
      publishingAgents: agents.filter((a) => a.publishes).length,
      campaigns: campaigns.length,
      awaitingButton: campaigns.filter((c) => c.stage === 'awaiting_button').length,
      published: campaigns.filter((c) => c.stage === 'published').length,
      touches: outreachItems.length,
    },
  }
}
