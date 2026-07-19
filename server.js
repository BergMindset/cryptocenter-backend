// Бэкенд соцслоя cryptocenter.finance. Fastify + Postgres (СВОЯ база, не Центра).
// Секреты — только в env (DATABASE_URL). CORS открыт для домена журнала.
// Первый общий слой: публичные метки адресов + личный вотчлист. Финансовых данных не храним.
import Fastify from 'fastify'
import cors from '@fastify/cors'
import postgres from 'postgres'
import crypto from 'node:crypto'
import { marked } from 'marked'
import { getFacts } from './lib/factory/facts.mjs'
import { checkPost } from './lib/factory/compliance.mjs'
import { createPublicClient, http, fallback, getAddress } from 'viem'
import { mainnet, arbitrum, optimism, polygon, base, bsc } from 'viem/chains'

const PORT = Number(process.env.PORT || 8080)
const DB = process.env.DATABASE_URL
if (!DB) {
  console.error('НЕТ DATABASE_URL — базы нет, старт отменён')
  process.exit(1)
}
const sql = postgres(DB, { ssl: 'require', max: 5 })
const app = Fastify({ logger: true })
await app.register(cors, { origin: true }) // разрешаем кросс-домен (журнал → бэкенд)
// Сервис «вход в пулы по схеме фонда» (MVP: Aerodrome/Base, стейбл-пары; юзер подписывает сам)
await app.register((await import('./lib/pools-routes.mjs')).default)

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

// --- Концентрированные позиции (Uniswap V3 / PancakeSwap V3) — читаем он-чейн ---
// V3-позиции = NFT, их не видно как балансы токенов. Считаем суммы из ликвидности и
// тиков (tick-математика), цены — через ценовой эндпоинт GoldRush. Только для чейнов,
// где у адреса реально есть позиции (balanceOf>0), через multicall — нагрузка ограничена.
const NPM_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'tokenOfOwnerByIndex', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'positions', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [
    { type: 'uint96' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint24' },
    { type: 'int24' }, { type: 'int24' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' } ] },
]
const FACTORY_ABI = [{ name: 'getPool', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], outputs: [{ type: 'address' }] }]
const POOL_ABI = [{ name: 'slot0', type: 'function', stateMutability: 'view', inputs: [], outputs: [
  { type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' } ] }]
const ERC20_ABI = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
]
const UNI = { npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984' }
const PANCAKE = { npm: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' }
const V3_SOURCES = [
  { title: 'Ethereum', color: '#6b8cff', gr: 'eth-mainnet', chain: mainnet, rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'], dexes: [{ protocol: 'Uniswap V3', ...UNI }, { protocol: 'PancakeSwap V3', ...PANCAKE }] },
  { title: 'Arbitrum', color: '#28a0f0', gr: 'arbitrum-mainnet', chain: arbitrum, rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'], dexes: [{ protocol: 'Uniswap V3', ...UNI }] },
  { title: 'Optimism', color: '#ff0420', gr: 'optimism-mainnet', chain: optimism, rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'], dexes: [{ protocol: 'Uniswap V3', ...UNI }] },
  { title: 'Polygon', color: '#8247e5', gr: 'matic-mainnet', chain: polygon, rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'], dexes: [{ protocol: 'Uniswap V3', ...UNI }] },
  { title: 'Base', color: '#0052ff', gr: 'base-mainnet', chain: base, rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], dexes: [{ protocol: 'Uniswap V3', npm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' }] },
  { title: 'BNB Chain', color: '#f0b90b', gr: 'bsc-mainnet', chain: bsc, rpcs: ['https://bsc-rpc.publicnode.com', 'https://binance.llamarpc.com'], dexes: [{ protocol: 'PancakeSwap V3', ...PANCAKE }, { protocol: 'Uniswap V3', npm: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613', factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7' }] },
]
const ZERO = '0x0000000000000000000000000000000000000000'

// суммы токенов позиции из ликвидности и тиков (float — для отображения оценки)
function amountsFor(liquidity, tickLower, tickUpper, sqrtPriceX96, curTick) {
  const L = Number(liquidity)
  const sa = Math.pow(1.0001, tickLower / 2)
  const sb = Math.pow(1.0001, tickUpper / 2)
  const sp = Number(sqrtPriceX96) / 2 ** 96
  let a0 = 0, a1 = 0
  if (curTick < tickLower) a0 = L * (sb - sa) / (sa * sb)
  else if (curTick >= tickUpper) a1 = L * (sb - sa)
  else { a0 = L * (sb - sp) / (sp * sb); a1 = L * (sp - sa) }
  return { a0, a1 }
}

async function grPrices(grChain, addrs) {
  const map = {}
  if (!addrs.length || !GR_KEY) return map
  try {
    const url = `https://api.covalenthq.com/v1/pricing/historical_by_addresses_v2/${grChain}/USD/${addrs.join(',')}/`
    const d = await fetch(url, { headers: { Authorization: `Bearer ${GR_KEY}` } }).then((r) => r.json())
    for (const it of d.data || []) map[it.contract_address.toLowerCase()] = it.items?.[0]?.price ?? null
  } catch { /* цены недоступны — покажем позицию без $ */ }
  return map
}

async function readV3Chain(source, owner) {
  const client = createPublicClient({ chain: source.chain, transport: fallback(source.rpcs.map((u) => http(u)), { rank: false }) })
  const raw = []
  for (const dex of source.dexes) {
    let n = 0
    try { n = Number(await client.readContract({ address: dex.npm, abi: NPM_ABI, functionName: 'balanceOf', args: [owner] })) } catch { continue }
    if (!n) continue
    const cap = Math.min(n, 80)
    const tok = await client.multicall({ contracts: Array.from({ length: cap }, (_, i) => ({ address: dex.npm, abi: NPM_ABI, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(i)] })), allowFailure: true })
    const ids = tok.filter((t) => t.status === 'success').map((t) => t.result)
    if (!ids.length) continue
    const pos = await client.multicall({ contracts: ids.map((id) => ({ address: dex.npm, abi: NPM_ABI, functionName: 'positions', args: [id] })), allowFailure: true })
    const items = []
    for (const r of pos) if (r.status === 'success' && r.result[7] > 0n) {
      const p = r.result
      items.push({ token0: p[2], token1: p[3], fee: p[4], tickLower: p[5], tickUpper: p[6], liquidity: p[7] })
    }
    if (!items.length) continue
    const pools = await client.multicall({ contracts: items.map((p) => ({ address: dex.factory, abi: FACTORY_ABI, functionName: 'getPool', args: [p.token0, p.token1, p.fee] })), allowFailure: true })
    items.forEach((p, i) => { p.pool = pools[i].status === 'success' ? pools[i].result : null })
    const withPool = items.filter((p) => p.pool && p.pool !== ZERO)
    if (!withPool.length) continue
    const slots = await client.multicall({ contracts: withPool.map((p) => ({ address: p.pool, abi: POOL_ABI, functionName: 'slot0' })), allowFailure: true })
    withPool.forEach((p, i) => { if (slots[i].status === 'success') { p.sqrtP = slots[i].result[0]; p.tick = slots[i].result[1] } })
    const live = withPool.filter((p) => p.sqrtP != null)
    if (!live.length) continue
    const toks = [...new Set(live.flatMap((p) => [p.token0.toLowerCase(), p.token1.toLowerCase()]))]
    const meta = await client.multicall({ contracts: toks.flatMap((t) => [{ address: t, abi: ERC20_ABI, functionName: 'symbol' }, { address: t, abi: ERC20_ABI, functionName: 'decimals' }]), allowFailure: true })
    const m = {}
    toks.forEach((t, i) => { m[t] = { sym: meta[i * 2].status === 'success' ? meta[i * 2].result : '?', dec: meta[i * 2 + 1].status === 'success' ? Number(meta[i * 2 + 1].result) : 18 } })
    const prices = await grPrices(source.gr, toks)
    for (const p of live) {
      const t0 = p.token0.toLowerCase(), t1 = p.token1.toLowerCase()
      const { a0, a1 } = amountsFor(p.liquidity, p.tickLower, p.tickUpper, p.sqrtP, p.tick)
      const amt0 = a0 / 10 ** m[t0].dec, amt1 = a1 / 10 ** m[t1].dec
      const priced = prices[t0] != null || prices[t1] != null
      const usd = amt0 * (prices[t0] ?? 0) + amt1 * (prices[t1] ?? 0)
      raw.push({
        protocol: dex.protocol, chainTitle: source.title, chainColor: source.color,
        pair: `${m[t0].sym}/${m[t1].sym}`, feePct: Number(p.fee) / 10000,
        inRange: p.tick >= p.tickLower && p.tick < p.tickUpper,
        amt0, sym0: m[t0].sym, amt1, sym1: m[t1].sym, usd: priced ? usd : null,
      })
    }
  }
  return raw
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((res) => setTimeout(() => res([]), ms))])
}

app.get('/api/defi-v3/:address', async (req, reply) => {
  const a = String(req.params.address || '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return reply.code(400).send({ error: 'bad address' })
  if (!GR_KEY) return reply.code(503).send({ error: 'no provider key' })
  const owner = getAddress(a)
  const res = await Promise.allSettled(V3_SOURCES.map((s) => withTimeout(readV3Chain(s, owner), 22000)))
  const positions = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  positions.sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1))
  const total = positions.reduce((s, p) => s + (p.usd ?? 0), 0)
  return { address: a, positions, total }
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

// ============================================================================
// Редакционный конвейер: статья на проверку в Telegram → кнопки → авто-публикация
// Черновики лежат в media-center@marketing:frontend/drafts/<slug>.md (в прод не идут).
// Публикация = перенос draft→content через GitHub API + repository_dispatch (Action
// пересобирает сайт и катит в прод). Кнопки — ссылки с HMAC-подписью (не callback,
// чтобы не трогать webhook существующего бота). Секреты — только в env.
// ============================================================================
const RV = {
  bot: process.env.REVIEW_BOT_TOKEN || '',
  chat: process.env.FOUNDER_CHAT_ID || '',
  sign: process.env.REVIEW_SIGN_SECRET || '',
  admin: process.env.REVIEW_ADMIN_TOKEN || '',
  gh: process.env.GH_TOKEN_BM || '',
  base: (process.env.PUBLIC_BASE || '').replace(/\/$/, ''),
}
const SRC = { owner: 'BergMindset', repo: 'media-center', branch: 'marketing' }
const ghHeaders = { authorization: `Bearer ${RV.gh}`, accept: 'application/vnd.github+json', 'user-agent': 'cryptocenter-review' }

const safeSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80)
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const sign = (slug, action) => crypto.createHmac('sha256', RV.sign).update(`${action}:${slug}`).digest('hex').slice(0, 40)
const verify = (slug, action, sig) => !!sig && sig.length === 40 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(slug, action)))

function parseFm(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const fm = m ? m[1] : ''
  const body = m ? m[2] : md
  const pick = (k) => {
    const r = fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : ''
  }
  return { title: pick('title'), lead: pick('lead'), body }
}

async function ghGetFile(path) {
  const r = await fetch(`https://api.github.com/repos/${SRC.owner}/${SRC.repo}/contents/${path}?ref=${SRC.branch}`, { headers: ghHeaders })
  if (r.status !== 200) return null
  const j = await r.json()
  return { sha: j.sha, content: j.content }
}
async function ghReq(method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, { method, headers: { ...ghHeaders, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
async function tgSend(text, buttons) {
  if (!RV.bot || !RV.chat) return { ok: false }
  const body = { chat_id: RV.chat, text, parse_mode: 'HTML', disable_web_page_preview: true }
  if (buttons) body.reply_markup = { inline_keyboard: buttons }
  const r = await fetch(`https://api.telegram.org/bot${RV.bot}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return r.json().catch(() => ({ ok: false }))
}

async function publishArticle(slug) {
  const draftPath = `frontend/drafts/${slug}.md`
  const contentPath = `frontend/content/crypto/${slug}.md`
  const draft = await ghGetFile(draftPath)
  if (!draft) return { ok: false, error: 'черновик не найден' }
  const existing = await ghGetFile(contentPath)
  const b64 = draft.content.replace(/\s+/g, '')
  const put = await ghReq('PUT', `/repos/${SRC.owner}/${SRC.repo}/contents/${contentPath}`, {
    message: `publish: ${slug}`, content: b64, branch: SRC.branch, ...(existing ? { sha: existing.sha } : {}),
  })
  if (put.status >= 300) return { ok: false, error: 'commit контента: ' + put.status }
  await ghReq('DELETE', `/repos/${SRC.owner}/${SRC.repo}/contents/${draftPath}`, { message: `published: ${slug}`, sha: draft.sha, branch: SRC.branch })
  const disp = await ghReq('POST', `/repos/${SRC.owner}/${SRC.repo}/dispatches`, { event_type: 'publish', client_payload: { slug } })
  if (disp.status >= 300) return { ok: false, error: 'dispatch сборки: ' + disp.status }
  return { ok: true }
}

function page(title, body, kind) {
  const accent = kind === 'ok' ? '#a8e34b' : kind === 'err' ? '#ff2e7e' : '#00e0d0'
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1219;color:#e9eef4;font-family:system-ui,sans-serif}
.c{max-width:440px;padding:34px;text-align:center}.b{width:56px;height:56px;border-radius:50%;margin:0 auto 20px;border:2px solid ${accent};display:flex;align-items:center;justify-content:center;font-size:26px;color:${accent}}
h1{font-size:22px;margin:0 0 10px}p{color:#8b98a9;line-height:1.6;margin:0}</style></head>
<body><div class="c"><div class="b">${kind === 'ok' ? '✓' : kind === 'err' ? '!' : '•'}</div><h1>${esc(title)}</h1><p>${body}</p></div></body></html>`
}

function previewPage(title, lead, html) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — черновик</title>
<style>:root{--tl:#00e0d0}body{margin:0;background:#0d1219;color:#e9eef4;font-family:system-ui,-apple-system,sans-serif;font-size:17px;line-height:1.7}
.w{max-width:44rem;margin:0 auto;padding:20px 22px 90px}.stamp{font:600 11px ui-monospace,monospace;letter-spacing:.14em;color:#ff2e7e;border:1px solid rgba(255,46,126,.4);padding:4px 9px;border-radius:999px;text-transform:uppercase;display:inline-block;margin:8px 0 22px}
h1{font-size:clamp(26px,5vw,40px);line-height:1.15;font-weight:800;margin:0 0 16px}.lead{color:#8b98a9;font-size:18px;margin:0 0 26px}
h2{font-size:24px;font-weight:800;margin:40px 0 6px}h3{font-size:18px;margin:26px 0 4px}p{margin:15px 0}a{color:var(--tl)}strong{color:#e9eef4}
blockquote{margin:24px 0;padding:12px 18px;border-left:2px solid var(--tl);background:rgba(0,224,208,.06);color:#e9eef4}
table{width:100%;border-collapse:collapse;font-size:14.5px;margin:20px 0;display:block;overflow-x:auto}th,td{padding:11px 14px;border:1px solid #1d2635;text-align:left}th{background:#0f1620;font:600 12px ui-monospace,monospace;text-transform:uppercase;color:#8b98a9}td:first-child{color:var(--tl);font-weight:700}
code{font-family:ui-monospace,monospace;background:#0f1620;padding:2px 6px;border-radius:4px;color:#a8e34b}
hr{border:0;border-top:1px solid #1d2635;margin:34px 0}</style></head>
<body><div class="w"><span class="stamp">черновик · превью</span><h1>${esc(title)}</h1><p class="lead">${esc(lead)}</p>${html}</div></body></html>`
}

const reviewGuard = (reply) => { if (!RV.bot || !RV.gh || !RV.sign) { reply.code(503).send({ error: 'review pipeline not configured' }); return false } return true }

// Отправить черновик основателю на проверку (защищено admin-ключом; дёргаю я).
app.get('/api/review/send/:slug', async (req, reply) => {
  if (!reviewGuard(reply)) return
  if (req.query.key !== RV.admin || !RV.admin) return reply.code(403).send({ error: 'forbidden' })
  const slug = safeSlug(req.params.slug)
  const draft = await ghGetFile(`frontend/drafts/${slug}.md`)
  if (!draft) return reply.code(404).send({ error: 'draft not found' })
  const { title, lead } = parseFm(Buffer.from(draft.content, 'base64').toString('utf8'))
  const text = `📝 <b>Статья на проверку</b>\n\n<b>${esc(title)}</b>\n\n${esc(lead).slice(0, 600)}`
  const buttons = [
    [{ text: '👀 Черновик', url: `${RV.base}/api/review/preview/${slug}` }],
    [{ text: '✅ Опубликовать', url: `${RV.base}/api/review/publish/${slug}?sig=${sign(slug, 'publish')}` },
     { text: '✏️ На редакцию', url: `${RV.base}/api/review/reject/${slug}?sig=${sign(slug, 'reject')}` }],
  ]
  const r = await tgSend(text, buttons)
  return { ok: !!r.ok, slug, title }
})

// Превью черновика (или уже опубликованной) — рендер Markdown в HTML.
app.get('/api/review/preview/:slug', async (req, reply) => {
  const slug = safeSlug(req.params.slug)
  const f = (await ghGetFile(`frontend/drafts/${slug}.md`)) || (await ghGetFile(`frontend/content/crypto/${slug}.md`))
  reply.type('text/html; charset=utf-8')
  if (!f) { reply.code(404); return page('Не найдено', 'Черновик не найден.', 'err') }
  const { title, lead, body } = parseFm(Buffer.from(f.content, 'base64').toString('utf8'))
  return previewPage(title, lead, marked.parse(body))
})

// Кнопка «Опубликовать» → перенос в content + запуск сборки.
app.get('/api/review/publish/:slug', async (req, reply) => {
  const slug = safeSlug(req.params.slug)
  reply.type('text/html; charset=utf-8')
  if (!RV.gh || !RV.sign) { reply.code(503); return page('Не настроено', 'Конвейер публикации не сконфигурирован.', 'err') }
  if (!verify(slug, 'publish', req.query.sig)) { reply.code(403); return page('Отказано', 'Неверная или устаревшая подпись ссылки.', 'err') }
  const res = await publishArticle(slug)
  if (!res.ok) { reply.code(400); return page('Не удалось опубликовать', esc(res.error), 'err') }
  await tgSend(`✅ Опубликовано: <b>${esc(slug)}</b>\nСайт обновится через ~2 минуты.`, null)
  return page('Опубликовано ✓', 'Статья ушла в прод. Сайт cryptocenter.finance обновится через ~2 минуты.', 'ok')
})

// Кнопка «На редакцию» → пометка на доработку.
app.get('/api/review/reject/:slug', async (req, reply) => {
  const slug = safeSlug(req.params.slug)
  reply.type('text/html; charset=utf-8')
  if (!verify(slug, 'reject', req.query.sig)) { reply.code(403); return page('Отказано', 'Неверная подпись ссылки.', 'err') }
  await tgSend(`✏️ На редакцию: <b>${esc(slug)}</b>\nЧерновик остаётся неопубликованным — жду правок.`, null)
  return page('Отправлено на редакцию', 'Черновик остался неопубликованным. Редакция получила пометку.', 'ok')
})

// ============================================================================
// КОНТЕНТ-ФАБРИКА GLASS ENGINE: комплаенс-гейт + ревью ЛЮБОГО поста → кнопка.
// Переиспользует @BergAlertsbot + HMAC-кнопки (как журнал). Инвариант: 0 публикаций
// мимо кнопки. Гейт блокирует ОТПРАВКУ превью (брак не доходит до основателя).
// Публикация = пост в канал (если бот админ) либо готовый текст основателю в личку.
// ============================================================================
sql`create table if not exists factory_posts (
  id text primary key, text text not null, channel text, lang text default 'ru',
  verdict jsonb, status text default 'pending', created_at timestamptz default now()
)`.catch((e) => console.error('factory_posts table:', e.message))

const safeId = (s) => String(s || '').replace(/[^a-f0-9]/g, '').slice(0, 32)
const newId = () => crypto.randomBytes(8).toString('hex')

function verdictLine(v) {
  const blocks = v.violations.filter((x) => x.severity === 'block')
  const warns = v.violations.filter((x) => x.severity === 'warn')
  if (v.pass && !warns.length) return `✅ Комплаенс PASS · цифр сверено: ${v.checkedNumbers} · вне реестра: 0`
  if (v.pass) return `✅ PASS · ⚠️ ${warns.map((w) => w.detail).join('; ')}`
  return `⛔ BLOCK: ${blocks.map((b) => b.detail).join('; ')}`
}

async function tgPostChannel(channel, text) {
  if (!RV.bot) return { ok: false, description: 'нет токена бота' }
  const r = await fetch(`https://api.telegram.org/bot${RV.bot}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: channel, text }),
  })
  return r.json().catch(() => ({ ok: false, description: 'bad response' }))
}

// Только проверка комплаенса (без отправки) — отладка и предпросмотр вердикта.
app.post('/api/factory/check', async (req, reply) => {
  if (req.query.key !== RV.admin || !RV.admin) return reply.code(403).send({ error: 'forbidden' })
  const facts = await getFacts()
  const verdict = checkPost(String(req.body?.text || ''), facts)
  return { verdict, summary: verdictLine(verdict), centerUp: verdict.centerUp }
})

// Отправить пост основателю на ревью — ТОЛЬКО если прошёл комплаенс.
app.post('/api/factory/review', async (req, reply) => {
  if (!RV.bot || !RV.sign) return reply.code(503).send({ error: 'not configured' })
  if (req.query.key !== RV.admin || !RV.admin) return reply.code(403).send({ error: 'forbidden' })
  const text = String(req.body?.text || '').trim()
  if (text.length < 10) return reply.code(400).send({ error: 'empty text' })
  const channel = String(req.body?.channel || '@YLDXMAIN').slice(0, 40)
  const lang = String(req.body?.lang || 'ru').slice(0, 5)
  const facts = await getFacts()
  const verdict = checkPost(text, facts)
  if (!verdict.pass) return { ok: false, blocked: true, verdict, summary: verdictLine(verdict) } // гейт: превью не уходит
  const id = newId()
  await sql`insert into factory_posts (id, text, channel, lang, verdict) values (${id}, ${text}, ${channel}, ${lang}, ${sql.json(verdict)})`
  const preview = `📣 <b>Пост на проверку</b> → ${esc(channel)}\n\n${esc(text).slice(0, 3600)}\n\n${esc(verdictLine(verdict))}`
  const buttons = [[
    { text: '✅ Опубликовать', url: `${RV.base}/api/factory/publish/${id}?sig=${sign(id, 'fpublish')}` },
    { text: '✏️ На редакцию', url: `${RV.base}/api/factory/reject/${id}?sig=${sign(id, 'freject')}` },
  ]]
  const r = await tgSend(preview, buttons)
  return { ok: !!r.ok, id, verdict, summary: verdictLine(verdict) }
})

// Кнопка «Опубликовать» → пост в канал (если бот админ), иначе готовый текст основателю.
app.get('/api/factory/publish/:id', async (req, reply) => {
  reply.type('text/html; charset=utf-8')
  const id = safeId(req.params.id)
  if (!verify(id, 'fpublish', req.query.sig)) { reply.code(403); return page('Отказано', 'Неверная подпись ссылки.', 'err') }
  const [row] = await sql`select * from factory_posts where id = ${id}`
  if (!row) { reply.code(404); return page('Не найдено', 'Пост не найден.', 'err') }
  if (row.status === 'published') return page('Уже опубликовано', 'Этот пост уже отправлен.', 'ok')
  const posted = await tgPostChannel(row.channel, row.text)
  await sql`update factory_posts set status = 'published' where id = ${id}`
  if (posted.ok) {
    await tgSend(`✅ Опубликовано в ${esc(row.channel)}.`, null)
    return page('Опубликовано ✓', `Пост ушёл в ${esc(row.channel)}. Проверь канал.`, 'ok')
  }
  await tgSend(`⚠️ Не смог запостить в ${esc(row.channel)} (${esc(posted.description || 'бот не админ')}). Готовый пост — вставь вручную:\n\n${esc(row.text)}`, null)
  return page('Готово к постингу', `Бот пока не админ ${esc(row.channel)} — прислал готовый пост тебе в личку. Добавь @BergAlertsbot админом канала — и публикация пойдёт прямо по кнопке.`, 'ok')
})

// Кнопка «На редакцию».
app.get('/api/factory/reject/:id', async (req, reply) => {
  reply.type('text/html; charset=utf-8')
  const id = safeId(req.params.id)
  if (!verify(id, 'freject', req.query.sig)) { reply.code(403); return page('Отказано', 'Неверная подпись ссылки.', 'err') }
  await sql`update factory_posts set status = 'rejected' where id = ${id}`
  await tgSend(`✏️ Пост на редакцию (id ${esc(id)}) — не опубликован, жду правок.`, null)
  return page('На редакцию', 'Пост не опубликован. Редакция получила пометку.', 'ok')
})

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => console.log('media-backend на :' + PORT))
