// Бэкенд соцслоя cryptocenter.finance. Fastify + Postgres (СВОЯ база, не Центра).
// Секреты — только в env (DATABASE_URL). CORS открыт для домена журнала.
// Первый общий слой: публичные метки адресов + личный вотчлист. Финансовых данных не храним.
import Fastify from 'fastify'
import cors from '@fastify/cors'
import postgres from 'postgres'

const PORT = Number(process.env.PORT || 8080)
const DB = process.env.DATABASE_URL
if (!DB) {
  console.error('НЕТ DATABASE_URL — базы нет, старт отменён')
  process.exit(1)
}
const sql = postgres(DB, { ssl: 'require', max: 5 })
const app = Fastify({ logger: true })
await app.register(cors, { origin: true }) // разрешаем кросс-домен (журнал → бэкенд)

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''))
const norm = (a) => String(a).toLowerCase()

app.get('/health', async () => ({ ok: true, ts: Date.now() }))

// --- Публичные метки адреса (shared) ---
app.get('/api/labels/:address', async (req, reply) => {
  if (!isAddr(req.params.address)) return reply.code(400).send({ error: 'bad address' })
  const rows = await sql`
    select id, label, note, votes, created_at from address_labels
    where lower(address) = ${norm(req.params.address)} and is_hidden = false
    order by votes desc, created_at desc limit 20`
  return { labels: rows }
})

app.post('/api/labels/:address', async (req, reply) => {
  if (!isAddr(req.params.address)) return reply.code(400).send({ error: 'bad address' })
  const label = String(req.body?.label || '').trim().slice(0, 60)
  const note = String(req.body?.note || '').trim().slice(0, 240) || null
  const author = String(req.body?.authorId || '').slice(0, 64) || null
  if (label.length < 2) return reply.code(400).send({ error: 'label too short' })
  const [row] = await sql`
    insert into address_labels (address, label, note, author_id)
    values (${norm(req.params.address)}, ${label}, ${note}, ${author})
    returning id, label, note, votes, created_at`
  return { label: row }
})

// --- Личный вотчлист (по owner_id = анонимный id браузера, позже — юзер) ---
app.get('/api/watchlist/:owner', async (req) => {
  const rows = await sql`
    select address, label, created_at from watchlist
    where owner_id = ${String(req.params.owner).slice(0, 64)} order by created_at desc`
  return { watchlist: rows }
})

app.post('/api/watchlist/:owner', async (req, reply) => {
  const owner = String(req.params.owner).slice(0, 64)
  if (!isAddr(req.body?.address)) return reply.code(400).send({ error: 'bad address' })
  const label = String(req.body?.label || '').trim().slice(0, 60) || null
  await sql`
    insert into watchlist (owner_id, address, label)
    values (${owner}, ${norm(req.body.address)}, ${label})
    on conflict (owner_id, address) do update set label = ${label}`
  return { ok: true }
})

app.delete('/api/watchlist/:owner/:address', async (req) => {
  await sql`delete from watchlist where owner_id = ${String(req.params.owner).slice(0, 64)}
    and lower(address) = ${norm(req.params.address)}`
  return { ok: true }
})

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => console.log('media-backend на :' + PORT))
