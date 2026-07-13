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

// --- Портфель по топ-сетям через GoldRush (ключ на сервере, в браузер не уходит) ---
const GR_KEY = process.env.GOLDRUSH_API_KEY || ''
// Топ-сети (имена GoldRush). Покрывает мажоров вкл. BNB, Polygon, Avalanche, Solana.
const GR_CHAINS = [
  { id: 'eth-mainnet', title: 'Ethereum', color: '#6b8cff' },
  { id: 'base-mainnet', title: 'Base', color: '#0052ff' },
  { id: 'arbitrum-mainnet', title: 'Arbitrum', color: '#28a0f0' },
  { id: 'optimism-mainnet', title: 'Optimism', color: '#ff0420' },
  { id: 'bsc-mainnet', title: 'BNB Chain', color: '#f0b90b' },
  { id: 'matic-mainnet', title: 'Polygon', color: '#8247e5' },
  { id: 'avalanche-mainnet', title: 'Avalanche', color: '#e84142' },
  { id: 'solana-mainnet', title: 'Solana', color: '#14f195' },
  { id: 'zksync-mainnet', title: 'zkSync Era', color: '#8c8dfc' },
  { id: 'linea-mainnet', title: 'Linea', color: '#61dfff' },
  { id: 'scroll-mainnet', title: 'Scroll', color: '#ffd9a8' },
  { id: 'blast-mainnet', title: 'Blast', color: '#fcfc03' },
  { id: 'mantle-mainnet', title: 'Mantle', color: '#65b3ae' },
  { id: 'gnosis-mainnet', title: 'Gnosis', color: '#3e6957' },
  { id: 'celo-mainnet', title: 'Celo', color: '#35d07f' },
  { id: 'fantom-mainnet', title: 'Fantom', color: '#1969ff' },
]

async function grChain(address, chain) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetch(
      `https://api.covalenthq.com/v1/${chain.id}/address/${address}/balances_v2/?no-spam=true&quote-currency=USD`,
      { headers: { Authorization: `Bearer ${GR_KEY}` }, signal: controller.signal },
    )
    clearTimeout(t)
    if (!res.ok) return { chain, total: 0, assets: [], ok: false }
    const d = await res.json()
    const assets = []
    for (const it of d.data?.items || []) {
      if (it.is_spam) continue
      const decimals = it.contract_decimals ?? 18
      const amount = it.balance ? Number(it.balance) / 10 ** decimals : 0
      if (amount <= 0) continue
      const usd = typeof it.quote === 'number' ? it.quote : null
      // анти-фейк: одиночная позиция > $5M почти всегда спам с фейк-ценой
      const trustedUsd = usd != null && usd < 5_000_000 ? usd : null
      assets.push({
        symbol: it.contract_ticker_symbol || '???',
        name: it.contract_name || '',
        amount,
        price: it.quote_rate ?? null,
        usd: trustedUsd,
        icon: it.logo_url || null,
        native: !!it.native_token,
      })
    }
    assets.sort((a, b) => (a.native !== b.native ? (a.native ? -1 : 1) : (b.usd ?? -1) - (a.usd ?? -1)))
    const total = assets.reduce((s, a) => s + (a.usd ?? 0), 0)
    const hidden = Math.max(0, assets.length - 40)
    return { chain, total, assets: assets.slice(0, 40), hidden, ok: true }
  } catch {
    clearTimeout(t)
    return { chain, total: 0, assets: [], hidden: 0, ok: false }
  }
}

app.get('/api/portfolio/:address', async (req, reply) => {
  const a = String(req.params.address || '')
  const evm = /^0x[0-9a-fA-F]{40}$/.test(a)
  const sol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) // грубая проверка Solana-адреса
  if (!evm && !sol) return reply.code(400).send({ error: 'bad address' })
  if (!GR_KEY) return reply.code(503).send({ error: 'no provider key' })
  // для EVM — EVM-сети; для Solana — только solana
  const chains = evm ? GR_CHAINS.filter((c) => c.id !== 'solana-mainnet') : GR_CHAINS.filter((c) => c.id === 'solana-mainnet')
  const res = await Promise.all(chains.map((c) => grChain(a, c)))
  const results = res.filter((r) => r.assets.length).sort((x, y) => y.total - x.total)
  const grandTotal = results.reduce((s, r) => s + r.total, 0)
  return { address: a, grandTotal, chains: results, scannedChains: chains.length }
})

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
