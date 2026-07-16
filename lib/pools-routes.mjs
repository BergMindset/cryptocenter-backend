// API сервиса «вход в пулы по схеме фонда» (MVP: Base + Aerodrome, стейбл-пары).
// Сервис строит ТОЛЬКО неподписанные транзакции; подписывает пользователь своим кошельком.
// Оплата: гейт добавляется отдельным шагом (модель «freemium + $9.99/вход + подписка», адрес оплат ждём).
import { baseClient, verifyPool, assertStablePair, buildEnterPlan, buildExitTxs, describePlan, DEFAULTS, CORRIDORS, AERODROME } from './slipstream-core.mjs'

const client = baseClient()

// BigInt → строки для JSON
const jsonSafe = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))

const metaPublic = (meta) => jsonSafe({
  addr: meta.addr,
  pair: `${meta.token0.symbol}/${meta.token1.symbol}`,
  token0: meta.token0,
  token1: meta.token1,
  tickSpacing: meta.tickSpacing,
  tick: meta.tick,
  price: meta.price,
  liquidity: meta.liquidity,
  verified: { factory: AERODROME.clFactory, nfpm: AERODROME.nfpm, checks: ['pool.factory()==factory', 'NFPM.factory()==factory', 'liquidity>0', 'slot0 live'] },
})

export default async function poolsRoutes(app) {
  // Витрина кандидатов: топ стейбл-пулов Aerodrome/Base из DefiLlama (справочно; адреса
  // Llama НЕ отдаёт надёжно — вход всегда через on-chain верификацию адреса).
  app.get('/api/pools/candidates', async (_req, reply) => {
    try {
      const res = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(15000) })
      const { data } = await res.json()
      const top = (data || [])
        .filter((p) => p.chain === 'Base' && /aerodrome/i.test(p.project) && p.stablecoin === true && p.tvlUsd >= 500_000 && p.apy > 0 && p.apy <= 1000)
        .sort((a, b) => b.apy - a.apy)
        .slice(0, 10)
        .map((p) => ({ symbol: p.symbol, project: p.project, tvlUsd: Math.round(p.tvlUsd), apy: +p.apy.toFixed(2), apyBase: p.apyBase != null ? +p.apyBase.toFixed(2) : null, llamaId: p.pool, poolMeta: p.poolMeta ?? null }))
      return { ok: true, venue: 'aerodrome/base', corridors: CORRIDORS, disclaimer: 'Не является финансовой рекомендацией. Данные DefiLlama, справочно.', pools: top }
    } catch (e) {
      reply.code(502)
      return { ok: false, error: 'DefiLlama недоступна: ' + e.message }
    }
  })

  // On-chain верификация пула (страница /verify и предпросмотр): тройная сверка как у фонда.
  app.get('/api/pools/verify/:address', async (req, reply) => {
    try {
      const meta = await verifyPool(client, req.params.address)
      return { ok: true, pool: metaPublic(meta) }
    } catch (e) {
      reply.code(422)
      return { ok: false, error: e.message }
    }
  })

  // План входа: { pool, wallet, budgetUsd } → 5 неподписанных транзакций + человеческое описание.
  app.post('/api/pools/plan', async (req, reply) => {
    const { pool, wallet, budgetUsd } = req.body || {}
    try {
      if (typeof budgetUsd !== 'number') throw new Error('budgetUsd должен быть числом')
      const meta = await verifyPool(client, String(pool || ''))
      assertStablePair(meta)
      const plan = buildEnterPlan(meta, budgetUsd, String(wallet || ''))
      return jsonSafe({
        ok: true,
        pool: metaPublic(meta),
        describe: describePlan(meta, plan, budgetUsd),
        txs: plan.txs.map((t) => ({ ...t, chainId: AERODROME.chainId })),
        limits: DEFAULTS,
        disclaimer: 'Конструктор транзакций. Вы подписываете сами; сервис не хранит ключи и не касается средств. Не является финансовой рекомендацией.',
      })
    } catch (e) {
      reply.code(422)
      return { ok: false, error: e.message }
    }
  })

  // План выхода из позиции (NFT юзера): { tokenId, liquidity, wallet } → 3 транзакции.
  app.post('/api/pools/exit-plan', async (req, reply) => {
    const { tokenId, liquidity, wallet } = req.body || {}
    try {
      if (!/^\d+$/.test(String(tokenId)) || !/^\d+$/.test(String(liquidity))) throw new Error('tokenId и liquidity — целые числа')
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(wallet || ''))) throw new Error('некорректный адрес кошелька')
      const txs = buildExitTxs(BigInt(tokenId), BigInt(liquidity), wallet)
      return jsonSafe({ ok: true, txs: txs.map((t) => ({ ...t, chainId: AERODROME.chainId })) })
    } catch (e) {
      reply.code(422)
      return { ok: false, error: e.message }
    }
  })
}
