// РАЗДАТЧИК (fan-out): одна кнопка основателя → пост уходит на все ПОДКЛЮЧЁННЫЕ
// площадки. Telegram публикует сам server.js (первичный канал); здесь — остальные.
// Инвариант фабрики не меняется: раздача стартует ТОЛЬКО после кнопки «Опубликовать».
// Площадка без ключа честно отвечает skipped+reason — ничего не выдумываем и не ломаемся.
// Секреты — только env DO-аппа; в ответах адаптеров токенов нет.

const env = (k) => process.env[k] || ''

async function vkPost(text) {
  // VK: пост на стену сообщества. Нужны VK_TOKEN (ключ доступа сообщества или
  // пользовательский с правом wall) и VK_OWNER_ID (для группы — со знаком минус, напр. -123456).
  const body = new URLSearchParams({
    owner_id: env('VK_OWNER_ID'),
    from_group: '1',
    message: text,
    access_token: env('VK_TOKEN'),
    v: '5.199',
  })
  const r = await fetch('https://api.vk.com/method/wall.post', { method: 'POST', body })
  const j = await r.json().catch(() => ({}))
  if (j.response?.post_id) return { ok: true, detail: `post_id ${j.response.post_id}` }
  return { ok: false, detail: j.error?.error_msg || `HTTP ${r.status}` }
}

// Реестр площадок. kind: text — умеет текстовые посты сейчас; video — ждёт видео-конвейера.
export const PLATFORMS = [
  {
    key: 'vk', label: 'ВКонтакте', kind: 'text',
    ready: () => !!(env('VK_TOKEN') && env('VK_OWNER_ID')),
    needs: 'VK_TOKEN + VK_OWNER_ID (ключ сообщества, право wall)',
    publish: vkPost,
  },
  {
    key: 'x', label: 'X (Twitter)', kind: 'text',
    ready: () => false, // красная линия: прямой X API не покупаем — через планировщик (Blotato)
    needs: 'Blotato (BLOTATO_API_KEY) — прямой X API не покупаем, ссылки в реплаях',
  },
  {
    key: 'linkedin', label: 'LinkedIn', kind: 'text',
    ready: () => false,
    needs: 'Blotato (BLOTATO_API_KEY) либо LinkedIn OAuth-app (ревью Microsoft)',
  },
  {
    key: 'instagram', label: 'Instagram', kind: 'video',
    ready: () => false,
    needs: 'бизнес-аккаунт + Meta Graph API либо Blotato; формат Reels 9:16',
  },
  {
    key: 'youtube', label: 'YouTube', kind: 'video',
    ready: () => false,
    needs: 'Google OAuth-app (YouTube Data API) либо Blotato; Shorts 9:16, галка altered/synthetic',
  },
  {
    key: 'tiktok', label: 'TikTok', kind: 'video',
    ready: () => false,
    needs: 'tiktok_connect в Higgsfield либо Blotato; AI-плашки обязательны, крипто-реклама запрещена',
  },
  {
    key: 'rutube', label: 'RuTube', kind: 'video',
    ready: () => false,
    needs: 'токен RuTube Studio (upload API); видео-платформа — ждёт видео-конвейера',
  },
]

/** Раздать текстовый пост на все готовые площадки. Возвращает отчёт по каждой. */
export async function distribute(text) {
  const results = []
  for (const p of PLATFORMS) {
    if (p.kind !== 'text') { results.push({ key: p.key, label: p.label, ok: false, skipped: true, detail: 'видео-платформа, ждёт видео-конвейера' }); continue }
    if (!p.ready() || !p.publish) { results.push({ key: p.key, label: p.label, ok: false, skipped: true, detail: `не подключено: ${p.needs}` }); continue }
    try {
      const r = await p.publish(text)
      results.push({ key: p.key, label: p.label, ok: !!r.ok, skipped: false, detail: r.detail || '' })
    } catch (e) {
      results.push({ key: p.key, label: p.label, ok: false, skipped: false, detail: String(e.message || e).slice(0, 200) })
    }
  }
  return results
}

/** Статус подключений для /api/media/status (без секретов). */
export function platformStatus() {
  return PLATFORMS.map((p) => ({ key: p.key, label: p.label, kind: p.kind, connected: p.ready(), needs: p.ready() ? null : p.needs }))
}
