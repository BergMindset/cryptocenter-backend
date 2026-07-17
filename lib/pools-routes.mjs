// API сервиса «вход в пулы по схеме фонда» (MVP: Base + Aerodrome, стейбл-пары).
// Сервис строит ТОЛЬКО неподписанные транзакции; подписывает пользователь своим кошельком.
// Оплата: гейт добавляется отдельным шагом (модель «freemium + $9.99/вход + подписка», адрес оплат ждём).
import { baseClient, verifyPool, assertStablePair, buildEnterPlan, buildExitTxs, describePlan, poolTick, listPositions, verifyPosition, checkBalances, DEFAULTS, CORRIDORS, AERODROME } from './slipstream-core.mjs'
import { subscriptionStatus, requireSubscription } from './subscription.mjs'

const client = baseClient()

// BigInt → строки для JSON
const jsonSafe = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))

// K1: короткий TTL-кэш ответов (тик 4с, витрина 5 мин) — сотни юзеров не долбят RPC/DefiLlama.
function makeTtlCache() {
  const store = new Map()
  return async (key, ttlMs, fn) => {
    const hit = store.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return hit.val
    const val = await fn()
    store.set(key, { at: Date.now(), val })
    return val
  }
}
const cache = makeTtlCache()

// K1: примитивный лимит запросов на IP (скользящее окно), защита от plan-спама и DoS.
function makeRateLimiter({ windowMs, max }) {
  const hits = new Map() // ip -> number[] (таймстемпы)
  return (ip) => {
    const now = Date.now()
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs)
    arr.push(now)
    hits.set(ip, arr)
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k)
    return arr.length <= max
  }
}
const rlRead = makeRateLimiter({ windowMs: 10_000, max: 40 }) // чтение: 40 / 10с
const rlWrite = makeRateLimiter({ windowMs: 10_000, max: 8 }) // построение планов: 8 / 10с
const clientIp = (req) => (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown')

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
  // Общий гейт лимита (fail-open по ошибке самого лимитера).
  const guard = (req, reply, limiter) => {
    try {
      if (!limiter(clientIp(req))) {
        reply.code(429)
        reply.send({ ok: false, error: 'слишком много запросов, подождите', code: 'RATE_LIMIT' })
        return false
      }
    } catch { /* лимитер не должен ронять запрос */ }
    return true
  }

  // Витрина кандидатов: топ стейбл-пулов Aerodrome/Base из DefiLlama (кэш 5 мин).
  app.get('/api/pools/candidates', async (req, reply) => {
    if (!guard(req, reply, rlRead)) return
    try {
      const top = await cache('candidates', 300_000, async () => {
        const res = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(15000) })
        if (!res.ok) throw new Error('DefiLlama ' + res.status)
        const { data } = await res.json()
        return (data || [])
          // B9: только Slipstream (CL) — v1/v2 AMM-пулы мы всё равно отвергнем на входе, не показываем.
          .filter((p) => p.chain === 'Base' && /aerodrome.*slipstream/i.test(p.project) && p.stablecoin === true && p.tvlUsd >= 500_000 && p.apy > 0 && p.apy <= 1000)
          .sort((a, b) => b.apy - a.apy)
          .slice(0, 10)
          .map((p) => ({ symbol: p.symbol, project: p.project, tvlUsd: Math.round(p.tvlUsd), apy: +p.apy.toFixed(2), apyBase: p.apyBase != null ? +p.apyBase.toFixed(2) : null, llamaId: p.pool, poolMeta: p.poolMeta ?? null }))
      })
      return { ok: true, venue: 'aerodrome/base', corridors: CORRIDORS, disclaimer: 'Не является финансовой рекомендацией. Данные DefiLlama, справочно.', pools: top }
    } catch (e) {
      reply.code(502)
      return { ok: false, error: 'DefiLlama недоступна: ' + e.message, code: 'UPSTREAM' }
    }
  })

  // On-chain верификация пула (тройная сверка). Мета кэшируется в ядре навсегда (неизменна).
  app.get('/api/pools/verify/:address', async (req, reply) => {
    if (!guard(req, reply, rlRead)) return
    try {
      const meta = await cache('verify:' + String(req.params.address).toLowerCase(), 30_000, () => verifyPool(client, req.params.address))
      return { ok: true, pool: metaPublic(meta) }
    } catch (e) {
      reply.code(422)
      return { ok: false, error: e.message, code: 'POOL_REJECTED' }
    }
  })

  // Статус подписки кошелька (для панели на /pools). Пока контракт не задан — «бесплатная бета».
  app.get('/api/pools/subscription/:wallet', async (req, reply) => {
    if (!guard(req, reply, rlRead)) return
    try {
      return jsonSafe({ ok: true, ...(await subscriptionStatus(req.params.wallet)) })
    } catch (e) {
      reply.code(422)
      return { ok: false, error: e.message, code: 'SUB_STATUS_FAILED' }
    }
  })

  // План входа: { pool, wallet, budgetUsd } → 5 неподписанных транзакций + человеческое описание.
  app.post('/api/pools/plan', async (req, reply) => {
    if (!guard(req, reply, rlWrite)) return
    const { pool, wallet, budgetUsd } = req.body || {}
    try {
      if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd)) throw new Error('budgetUsd должен быть числом')
      const w = String(wallet || '')
      // Платный гейт: активен ТОЛЬКО когда задеплоен контракт подписки (иначе бета бесплатна).
      const gate = await requireSubscription(w)
      if (!gate.ok) {
        reply.code(402)
        return jsonSafe({ ok: false, error: 'нужна активная подписка', code: 'SUBSCRIPTION_REQUIRED', subscription: gate.status })
      }
      const meta = await verifyPool(client, String(pool || ''))
      assertStablePair(meta)
      const plan = buildEnterPlan(meta, budgetUsd, w)
      // B7: честная проверка баланса — не дать подписать 2 approve, если на mint денег не хватит.
      const balance = await checkBalances(client, meta, w, plan.total0, plan.total1)
      return jsonSafe({
        ok: true,
        pool: metaPublic(meta),
        describe: describePlan(meta, plan, budgetUsd),
        txs: plan.txs.map((t) => ({ ...t, chainId: AERODROME.chainId })),
        limits: DEFAULTS,
        corridors: CORRIDORS, // B10: фронт рисует схему из этого, не из хардкода
        balance, // B7
        // K7: адреса, в которые СТРОГО должны идти все транзакции плана — фронт сверяет.
        allowedTargets: { nfpm: AERODROME.nfpm, token0: meta.token0.addr, token1: meta.token1.addr },
        disclaimer: 'Конструктор транзакций. Вы подписываете сами; сервис не хранит ключи и не касается средств. Не является финансовой рекомендацией.',
      })
    } catch (e) {
      reply.code(422)
      return { ok: false, error: e.message, code: 'PLAN_FAILED' }
    }
  })

  // Живой тик пула — лёгкий срез (кэш 4с: даже сотня юзеров = ~1 RPC-запрос/4с на пул).
  app.get('/api/pools/tick/:address', async (req, reply) => {
    if (!guard(req, reply, rlRead)) return
    try {
      const t = await cache('tick:' + String(req.params.address).toLowerCase(), 4000, () => poolTick(client, req.params.address))
      return { ok: true, ...t }
    } catch (e) {
      reply.code(422)
      return { ok: false, error: e.message, code: 'TICK_FAILED' }
    }
  })

  // Позиции кошелька в Aerodrome Slipstream (кэш 15с на адрес).
  app.get('/api/pools/positions/:wallet', async (req, reply) => {
    if (!guard(req, reply, rlRead)) return
    try {
      const r = await cache('pos:' + String(req.params.wallet).toLowerCase(), 15_000, () => listPositions(client, req.params.wallet))
      return jsonSafe({ ok: true, ...r })
    } catch (e) {
      reply.code(422)
      return { ok: false, error: e.message, code: 'POSITIONS_FAILED' }
    }
  })

  // План выхода: { tokenId, wallet } → 3 транзакции. K9: владение и ликвидность берём ИЗ ЧЕЙНА,
  // liquidity от клиента больше НЕ принимаем (иначе бэкенд = фабрика calldata для фишинга).
  app.post('/api/pools/exit-plan', async (req, reply) => {
    if (!guard(req, reply, rlWrite)) return
    const { tokenId, wallet } = req.body || {}
    try {
      const pos = await verifyPosition(client, tokenId, String(wallet || ''))
      const txs = buildExitTxs(pos, wallet) // B3: mins считаются внутри из pos
      return jsonSafe({ ok: true, tokenId: pos.tokenId.toString(), txs: txs.map((t) => ({ ...t, chainId: AERODROME.chainId })) })
    } catch (e) {
      reply.code(422)
      return { ok: false, error: e.message, code: 'EXIT_FAILED' }
    }
  })
}
