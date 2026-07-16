// Тест инвариантов ядра против ЖИВОГО Base — те же проверки, что эталонный dry-run фонда 14.07.2026:
// декодируем каждый calldata обратно и сверяем: spender=NFPM, recipient=owner, тики выровнены
// по спейсингу и содержат текущий тик, mins = desired−10%, суммы = доли 20/30/50, deadline в будущем.
// Плюс негативный тест: чужой адрес пула должен быть отвергнут.
// Запуск: node test/slipstream-invariants.mjs
import { decodeFunctionData } from 'viem'
import {
  baseClient, verifyPool, assertStablePair, buildEnterPlan, describePlan, poolTick, verifyPosition,
  AERODROME, CORRIDORS, NFPM_ABI, ERC20_ABI,
} from '../lib/slipstream-core.mjs'

const KNOWN_GOOD_POOL = '0xa41Bc0AFfbA7Fd420d186b84899d7ab2aC57fcD1' // USDC/USDT CL1 Base (эталон 14.07)
const DUMMY_OWNER = '0x1a936112B37D7e1CB4f32582152f0CDc2F726461' // тест-кошелёк (только recipient, ничего не подписывает)
const BUDGET = 100

let passed = 0
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name} ${detail}`) }
}

const client = baseClient()

console.log('1. verifyPool на эталонном пуле USDC/USDT…')
const meta = await verifyPool(client, KNOWN_GOOD_POOL)
check('пул принят тройной сверкой', meta.addr === KNOWN_GOOD_POOL)
check('пара стейблов', meta.token0.symbol.includes('USD') && meta.token1.symbol.includes('USD'), `${meta.token0.symbol}/${meta.token1.symbol}`)
check('цена ≈ 1', Math.abs(meta.price - 1) < 0.05, `price=${meta.price}`)
assertStablePair(meta)
console.log(`  пул: ${meta.token0.symbol}/${meta.token1.symbol}, тик ${meta.tick}, spacing ${meta.tickSpacing}, liq ${meta.liquidity}`)

console.log('2. Негативный тест: чужой адрес (NFPM сам) должен быть отвергнут…')
let rejected = false
try { await verifyPool(client, AERODROME.nfpm) } catch { rejected = true }
check('чужой адрес отвергнут', rejected)

console.log(`3. План входа $${BUDGET} для кошелька юзера…`)
const plan = buildEnterPlan(meta, BUDGET, DUMMY_OWNER)
check('транзакций 5 (2 approve + 3 mint)', plan.txs.length === 5, `= ${plan.txs.length}`)

const approves = plan.txs.filter((t) => t.step.startsWith('approve'))
for (const tx of approves) {
  const d = decodeFunctionData({ abi: ERC20_ABI, data: tx.data })
  check(`${tx.step}: spender = NFPM`, d.args[0].toLowerCase() === AERODROME.nfpm.toLowerCase())
  const isT0 = tx.to.toLowerCase() === meta.token0.addr.toLowerCase()
  check(`${tx.step}: сумма = точный total`, d.args[1] === (isT0 ? plan.total0 : plan.total1))
}

const mints = plan.txs.filter((t) => t.step.startsWith('mint'))
check('mint ×3', mints.length === 3)
const now = Math.floor(Date.now() / 1000)
mints.forEach((tx, i) => {
  const d = decodeFunctionData({ abi: NFPM_ABI, data: tx.data })
  const p = d.args[0]
  const name = CORRIDORS[i].name
  check(`mint ${name}: to = NFPM`, tx.to.toLowerCase() === AERODROME.nfpm.toLowerCase())
  check(`mint ${name}: recipient = кошелёк юзера`, p.recipient.toLowerCase() === DUMMY_OWNER.toLowerCase())
  check(`mint ${name}: тики выровнены по спейсингу`, p.tickLower % meta.tickSpacing === 0 && p.tickUpper % meta.tickSpacing === 0, `[${p.tickLower},${p.tickUpper}]`)
  check(`mint ${name}: текущий тик внутри коридора`, p.tickLower <= meta.tick && meta.tick <= p.tickUpper, `тик ${meta.tick} ∉ [${p.tickLower},${p.tickUpper}]`)
  check(`mint ${name}: mins = desired − 10%`, p.amount0Min === (p.amount0Desired * 900n) / 1000n && p.amount1Min === (p.amount1Desired * 900n) / 1000n)
  check(`mint ${name}: deadline в будущем (≤ 61 мин)`, Number(p.deadline) > now && Number(p.deadline) <= now + 61 * 60)
  check(`mint ${name}: sqrtPriceX96 = 0 (пул существует)`, p.sqrtPriceX96 === 0n)
})

// Доли капитала 20/30/50: стоимость коридора = amt0×P + amt1 (в token1 ≈ $)
const corridorUsd = plan.plans.map((p) => Number(p.amount0) / 10 ** meta.token0.decimals * meta.price + Number(p.amount1) / 10 ** meta.token1.decimals)
const totalUsd = corridorUsd.reduce((s, v) => s + v, 0)
check('суммарный капитал ≈ бюджету (±1%)', Math.abs(totalUsd - BUDGET) / BUDGET < 0.01, `= $${totalUsd.toFixed(2)}`)
CORRIDORS.forEach((c, i) => {
  const share = corridorUsd[i] / totalUsd
  check(`доля ${c.name} ≈ ${c.share * 100}% (±2 п.п.)`, Math.abs(share - c.share) < 0.02, `= ${(share * 100).toFixed(1)}%`)
})

console.log('4. describePlan (то, что видит юзер)…')
const desc = describePlan(meta, plan, BUDGET)
check('describe: пул и суммы читаемы', desc.pool.includes('/') && desc.need[meta.token0.symbol] >= 0 && desc.corridors.length === 3)
console.log(`  нужно: ${JSON.stringify(desc.need)}`)

console.log('5. K3: poolTick после verify берёт decimals из кэша (не хардкод 6/6)…')
const tk = await poolTick(client, KNOWN_GOOD_POOL)
check('tick: цена ≈ 1 (decimals корректны)', Math.abs(tk.price - 1) < 0.05, `price=${tk.price}`)

console.log('6. K9: verifyPosition отвергает несуществующую/чужую позицию…')
let posRejected = false
try { await verifyPosition(client, '999999999', DUMMY_OWNER) } catch { posRejected = true }
check('несуществующая позиция отвергнута', posRejected)
let addrRejected = false
try { await verifyPosition(client, '1', 'нонсенс') } catch { addrRejected = true }
check('битый адрес отвергнут', addrRejected)

console.log(`\nИТОГ: ${passed} ✓ / ${failed} ✗`)
process.exit(failed ? 1 : 0)
