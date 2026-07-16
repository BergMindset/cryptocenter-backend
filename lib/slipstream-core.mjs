// Ядро входа в CL-пулы Aerodrome Slipstream (Base) — публичная версия мозга фонда.
// Прямой порт Skulls Automation slipstream.service.ts (эталон: dry-run на живом Base 14.07.2026).
// Строит ТОЛЬКО неподписанные транзакции; подписывает пользователь своим кошельком.
// Здесь НЕТ приватных адресов фонда — только публичные контракты Aerodrome (сверены on-chain 14.07).
import { createPublicClient, http, fallback, encodeFunctionData, parseAbi } from 'viem'
import { base } from 'viem/chains'

// ── Публичные контракты Aerodrome Slipstream на Base (chainId 8453) ──
// Сверено on-chain 14.07.2026: NFPM.factory() == clFactory, mint-селектор в байткоде.
export const AERODROME = {
  chainId: 8453,
  clFactory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
  nfpm: '0x827922686190790b37229fd06084350E74485b72',
}

// Схема фонда: три коридора вокруг цены, доли капитала 20/30/50 (публичная методология).
export const CORRIDORS = [
  { name: 'tight', pct: 2.5, share: 0.2 },
  { name: 'medium', pct: 5, share: 0.3 },
  { name: 'wide', pct: 10, share: 0.5 },
]

export const DEFAULTS = {
  slippagePct: 10, // mins = desired − 10% (стейбл-пары; защита от сдвига пропорции пула)
  deadlineMinutes: 60, // юзер подписывает в браузере — час, не сутки как у демона
  minBudgetUsd: 10,
  maxBudgetUsd: 1_000_000,
}

const FACTORY_ABI = parseAbi(['function getPool(address,address,int24) view returns (address)'])
const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function factory() view returns (address)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)',
])
const ERC20_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
const ERC20_META_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])
// ABI сверен с верифицированным NFPM (Slipstream: tickSpacing вместо fee + хвостовой sqrtPriceX96).
export const NFPM_ABI = parseAbi([
  'struct MintParams { address token0; address token1; int24 tickSpacing; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; uint160 sqrtPriceX96; }',
  'struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function factory() view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
])
export { ERC20_ABI }

const MAX_UINT128 = (1n << 128n) - 1n

export function baseClient(rpcs = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base.drpc.org']) {
  return createPublicClient({ chain: base, transport: fallback(rpcs.map((u) => http(u)), { rank: false }) })
}

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

/**
 * ВЕРИФИКАЦИЯ пула по адресу извне (анти-poisoning, как у фонда):
 * pool.factory() == приваренная фабрика == NFPM.factory(), liquidity>0, живой slot0;
 * symbol/decimals токенов читаются из САМИХ контрактов. Любая осечка = throw.
 */
export async function verifyPool(client, poolAddr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(poolAddr)) throw new Error(`некорректный адрес пула: ${poolAddr}`)
  const [token0, token1, tickSpacing, poolFactory, nfpmFactory, liquidity, slot0] = await Promise.all([
    client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'token0' }),
    client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'token1' }),
    client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'tickSpacing' }),
    client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'factory' }),
    client.readContract({ address: AERODROME.nfpm, abi: NFPM_ABI, functionName: 'factory' }),
    client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'liquidity' }),
    client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'slot0' }),
  ])
  if (!eq(poolFactory, AERODROME.clFactory)) throw new Error(`pool.factory() ${poolFactory} ≠ фабрики Aerodrome — адрес отвергнут`)
  if (!eq(nfpmFactory, AERODROME.clFactory)) throw new Error(`NFPM.factory() ${nfpmFactory} ≠ фабрики Aerodrome`)
  if (liquidity === 0n) throw new Error(`пул ${poolAddr} пуст (liquidity=0)`)
  if (slot0[0] === 0n) throw new Error(`пул ${poolAddr} не инициализирован (sqrtPriceX96=0)`)

  const [sym0, dec0, sym1, dec1] = await Promise.all([
    client.readContract({ address: token0, abi: ERC20_META_ABI, functionName: 'symbol' }),
    client.readContract({ address: token0, abi: ERC20_META_ABI, functionName: 'decimals' }),
    client.readContract({ address: token1, abi: ERC20_META_ABI, functionName: 'symbol' }),
    client.readContract({ address: token1, abi: ERC20_META_ABI, functionName: 'decimals' }),
  ])
  const tick = Number(slot0[1])
  const price = Math.pow(1.0001, tick) * 10 ** (Number(dec0) - Number(dec1))
  return {
    addr: poolAddr,
    nfpm: AERODROME.nfpm,
    token0: { addr: token0, symbol: sym0, decimals: Number(dec0) },
    token1: { addr: token1, symbol: sym1, decimals: Number(dec1) },
    tickSpacing: Number(tickSpacing),
    tick,
    sqrtPriceX96: slot0[0],
    price,
    liquidity,
  }
}

/** Волатильность пары: MVP — только стейбл-пары (|цена − 1| ≤ 5%), как у фонда до этапа 2. */
export function assertStablePair(meta) {
  if (Math.abs(meta.price - 1) > 0.05)
    throw new Error(`пара ${meta.token0.symbol}/${meta.token1.symbol} волатильная (цена ${meta.price.toFixed(4)}) — этап 2, нужен ценовой источник`)
}

/** Цена → сырой тик (выравнивание по спейсингу делает buildEnterPlan). */
function priceToTick(price, decimals0, decimals1) {
  const raw = price * 10 ** (decimals1 - decimals0)
  return Math.log(raw) / Math.log(1.0001)
}

/** Суммы токенов под капитал в коридоре (математика Uniswap V3, как в эталоне). */
function corridorAmounts(meta, lowerPrice, upperPrice, capitalUsd) {
  const sqrtP = Math.sqrt(meta.price)
  const sqrtA = Math.sqrt(lowerPrice)
  const sqrtB = Math.sqrt(upperPrice)
  let amt0PerL = 0
  let amt1PerL = 0
  if (meta.price <= lowerPrice) amt0PerL = (sqrtB - sqrtA) / (sqrtA * sqrtB)
  else if (meta.price >= upperPrice) amt1PerL = sqrtB - sqrtA
  else {
    amt0PerL = (sqrtB - sqrtP) / (sqrtP * sqrtB)
    amt1PerL = sqrtP - sqrtA
  }
  const valuePerL = amt0PerL * meta.price + amt1PerL
  const L = capitalUsd / valuePerL // стейбл-пара: 1 token1 ≈ $1
  const amount0 = BigInt(Math.floor(L * amt0PerL * 10 ** meta.token0.decimals))
  const amount1 = BigInt(Math.floor(L * amt1PerL * 10 ** meta.token1.decimals))
  return { amount0, amount1 }
}

/**
 * План входа для КОШЕЛЬКА ПОЛЬЗОВАТЕЛЯ: 3 коридора вокруг текущей цены (±pct, доли 20/30/50),
 * транзакции approve точных сумм ×2 + mint ×3. recipient = owner (кошелёк юзера) — позиции его.
 */
export function buildEnterPlan(meta, budgetUsd, owner, opts = {}) {
  const slippagePct = opts.slippagePct ?? DEFAULTS.slippagePct
  const deadlineMinutes = opts.deadlineMinutes ?? DEFAULTS.deadlineMinutes
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error(`некорректный адрес кошелька: ${owner}`)
  if (!(budgetUsd >= DEFAULTS.minBudgetUsd && budgetUsd <= DEFAULTS.maxBudgetUsd))
    throw new Error(`бюджет вне диапазона $${DEFAULTS.minBudgetUsd}–$${DEFAULTS.maxBudgetUsd}`)

  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMinutes * 60)
  const minFactor = 1 - slippagePct / 100

  const corridors = CORRIDORS.map((c) => ({
    name: c.name,
    lower: meta.price * (1 - c.pct / 100),
    upper: meta.price * (1 + c.pct / 100),
    capitalUsd: budgetUsd * c.share,
  }))

  const plans = corridors.map((c) => {
    const rawLower = priceToTick(c.lower, meta.token0.decimals, meta.token1.decimals)
    const rawUpper = priceToTick(c.upper, meta.token0.decimals, meta.token1.decimals)
    let tickLower = Math.floor(rawLower / meta.tickSpacing) * meta.tickSpacing
    let tickUpper = Math.ceil(rawUpper / meta.tickSpacing) * meta.tickSpacing
    if (tickUpper <= tickLower) tickUpper = tickLower + meta.tickSpacing
    const { amount0, amount1 } = corridorAmounts(meta, c.lower, c.upper, c.capitalUsd)
    return { name: c.name, tickLower, tickUpper, amount0, amount1 }
  })

  const total0 = plans.reduce((s, p) => s + p.amount0, 0n)
  const total1 = plans.reduce((s, p) => s + p.amount1, 0n)

  const txs = []
  for (const [token, total] of [
    [meta.token0, total0],
    [meta.token1, total1],
  ]) {
    if (total === 0n) continue
    txs.push({
      step: `approve ${token.symbol}`,
      to: token.addr,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [meta.nfpm, total] }),
      value: '0',
      gasLimitHint: '60000',
    })
  }
  for (const p of plans) {
    txs.push({
      step: `mint ${p.name}`,
      to: meta.nfpm,
      data: encodeFunctionData({
        abi: NFPM_ABI,
        functionName: 'mint',
        args: [
          {
            token0: meta.token0.addr,
            token1: meta.token1.addr,
            tickSpacing: meta.tickSpacing,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            amount0Desired: p.amount0,
            amount1Desired: p.amount1,
            amount0Min: (p.amount0 * BigInt(Math.floor(minFactor * 1000))) / 1000n,
            amount1Min: (p.amount1 * BigInt(Math.floor(minFactor * 1000))) / 1000n,
            recipient: owner,
            deadline,
            sqrtPriceX96: 0n, // пул существует — поле создания не используется
          },
        ],
      }),
      value: '0',
      gasLimitHint: '600000',
    })
  }
  return { plans, txs, total0, total1, deadline: deadline.toString() }
}

/** План выхода одной NFT-позиции юзера: снять ликвидность → забрать токены → сжечь NFT. */
export function buildExitTxs(tokenId, liquidity, owner, opts = {}) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineMinutes ?? DEFAULTS.deadlineMinutes) * 60)
  const mk = (step, data, gas) => ({ step, to: AERODROME.nfpm, data, value: '0', gasLimitHint: gas })
  return [
    mk('decreaseLiquidity', encodeFunctionData({ abi: NFPM_ABI, functionName: 'decreaseLiquidity', args: [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline }] }), '300000'),
    mk('collect', encodeFunctionData({ abi: NFPM_ABI, functionName: 'collect', args: [{ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }] }), '200000'),
    mk('burn', encodeFunctionData({ abi: NFPM_ABI, functionName: 'burn', args: [tokenId] }), '150000'),
  ]
}

/** Лёгкий живой срез пула: тик/цена/ликвидность (для секундных обновлений на фронте). */
export async function poolTick(client, poolAddr, decimals0 = 6, decimals1 = 6) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(poolAddr)) throw new Error('некорректный адрес пула')
  const [slot0, liquidity] = await Promise.all([
    client.readContract({ address: poolAddr, abi: parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)']), functionName: 'slot0' }),
    client.readContract({ address: poolAddr, abi: parseAbi(['function liquidity() view returns (uint128)']), functionName: 'liquidity' }),
  ])
  const tick = Number(slot0[1])
  return { tick, price: Math.pow(1.0001, tick) * 10 ** (decimals0 - decimals1), liquidity: liquidity.toString(), ts: Date.now() }
}

/** Суммы токенов позиции из её ликвидности (математика Uniswap V3, обратная corridorAmounts). */
function amountsForLiquidity(L, tickCurrent, tickLower, tickUpper) {
  const sp = Math.pow(1.0001, tickCurrent / 2)
  const sa = Math.pow(1.0001, tickLower / 2)
  const sb = Math.pow(1.0001, tickUpper / 2)
  let a0 = 0
  let a1 = 0
  if (tickCurrent < tickLower) a0 = L * ((sb - sa) / (sa * sb))
  else if (tickCurrent >= tickUpper) a1 = L * (sb - sa)
  else {
    a0 = L * ((sb - sp) / (sp * sb))
    a1 = L * (sp - sa)
  }
  return { a0, a1 }
}

const NFPM_ENUM_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
])

/** Позиции кошелька в Aerodrome Slipstream: перечисление NFT + статус в/вне диапазона + оценка сумм. */
export async function listPositions(client, owner, { max = 25 } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error('некорректный адрес кошелька')
  const bal = await client.readContract({ address: AERODROME.nfpm, abi: NFPM_ENUM_ABI, functionName: 'balanceOf', args: [owner] })
  const count = Math.min(Number(bal), max)
  const out = []
  for (let i = 0; i < count; i++) {
    const tokenId = await client.readContract({ address: AERODROME.nfpm, abi: NFPM_ENUM_ABI, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(i)] })
    const pos = await client.readContract({ address: AERODROME.nfpm, abi: NFPM_ABI, functionName: 'positions', args: [tokenId] })
    const [token0, token1, tickSpacing, tickLower, tickUpper, liquidity] = [pos[2], pos[3], Number(pos[4]), Number(pos[5]), Number(pos[6]), pos[7]]
    if (liquidity === 0n) continue // пустые (сожжённые/выведенные) не показываем
    const poolAddr = await client.readContract({ address: AERODROME.clFactory, abi: FACTORY_ABI, functionName: 'getPool', args: [token0, token1, tickSpacing] })
    const [sym0, dec0, sym1, dec1, slot0] = await Promise.all([
      client.readContract({ address: token0, abi: ERC20_META_ABI, functionName: 'symbol' }),
      client.readContract({ address: token0, abi: ERC20_META_ABI, functionName: 'decimals' }),
      client.readContract({ address: token1, abi: ERC20_META_ABI, functionName: 'symbol' }),
      client.readContract({ address: token1, abi: ERC20_META_ABI, functionName: 'decimals' }),
      client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'slot0' }),
    ])
    const tick = Number(slot0[1])
    const { a0, a1 } = amountsForLiquidity(Number(liquidity), tick, tickLower, tickUpper)
    out.push({
      tokenId: tokenId.toString(),
      pool: poolAddr,
      pair: `${sym0}/${sym1}`,
      tickLower,
      tickUpper,
      tickCurrent: tick,
      inRange: tickLower <= tick && tick < tickUpper,
      liquidity: liquidity.toString(),
      amounts: { [sym0]: a0 / 10 ** Number(dec0), [sym1]: a1 / 10 ** Number(dec1) },
    })
  }
  return { total: Number(bal), shown: out.length, positions: out }
}

/** Человеческое описание плана — то, что видит юзер ПЕРЕД подписью (RU/EN делает фронт). */
export function describePlan(meta, plan, budgetUsd) {
  const h0 = (v) => Number(v) / 10 ** meta.token0.decimals
  const h1 = (v) => Number(v) / 10 ** meta.token1.decimals
  return {
    pool: `${meta.token0.symbol}/${meta.token1.symbol}`,
    poolAddr: meta.addr,
    budgetUsd,
    need: { [meta.token0.symbol]: h0(plan.total0), [meta.token1.symbol]: h1(plan.total1) },
    corridors: plan.plans.map((p, i) => ({
      name: p.name,
      pct: CORRIDORS[i].pct,
      share: CORRIDORS[i].share,
      ticks: [p.tickLower, p.tickUpper],
      amounts: { [meta.token0.symbol]: h0(p.amount0), [meta.token1.symbol]: h1(p.amount1) },
    })),
    currentTick: meta.tick,
    deadline: plan.deadline,
    recipient: 'ваш кошелёк — позиции (NFT) приходят на ваш адрес',
  }
}
