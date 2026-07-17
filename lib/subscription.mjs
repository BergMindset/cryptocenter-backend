// Подписка на сервис пулов ($20/мес, on-chain permit-контракт PoolsSubscription на Base).
// КОНФИГ-УПРАВЛЯЕМО: пока SUBSCRIPTION_CONTRACT не задан в env — гейт ВЫКЛЮЧЕН, бета бесплатна.
// Контракт деплоит основатель ПОСЛЕ независимого аудита; сервис только ЧИТАЕТ статус (view).
import { parseAbi } from 'viem'
import { baseClient, AERODROME } from './slipstream-core.mjs'

const client = baseClient()

// Адрес задеплоенного контракта — из env (пусто = подписка выключена, бета бесплатна).
export const SUB_CONTRACT = (process.env.SUBSCRIPTION_CONTRACT || '').trim()
export const SUB_PRICE_USD = Number(process.env.SUBSCRIPTION_PRICE_USD || 20)
export const SUB_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // USDC на Base
export const SUB_CHAIN_ID = AERODROME.chainId // 8453

export const isConfigured = () => /^0x[0-9a-fA-F]{40}$/.test(SUB_CONTRACT)

const SUB_ABI = parseAbi([
  'function isActive(address user) view returns (bool)',
  'function subs(address) view returns (uint64 paidUntil, bool autoRenew, uint96 priceCap)',
  'function price() view returns (uint256)',
])

/**
 * Статус подписки кошелька. Пока контракт не задан — гейт выключен (active:true, gated:false):
 * бета бесплатна для всех. Когда основатель задеплоит контракт и пропишет env — читаем on-chain.
 */
export async function subscriptionStatus(wallet) {
  if (!isConfigured()) {
    return { configured: false, gated: false, active: true, priceUsd: SUB_PRICE_USD }
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(wallet || ''))) {
    return { configured: true, gated: true, active: false, priceUsd: SUB_PRICE_USD }
  }
  try {
    const [active, sub] = await Promise.all([
      client.readContract({ address: SUB_CONTRACT, abi: SUB_ABI, functionName: 'isActive', args: [wallet] }),
      client.readContract({ address: SUB_CONTRACT, abi: SUB_ABI, functionName: 'subs', args: [wallet] }),
    ])
    return {
      configured: true,
      gated: true,
      active: Boolean(active),
      paidUntil: Number(sub[0]) || 0,
      autoRenew: Boolean(sub[1]),
      priceUsd: SUB_PRICE_USD,
      contract: SUB_CONTRACT,
      token: SUB_TOKEN,
      chainId: SUB_CHAIN_ID,
    }
  } catch (e) {
    // Не смогли прочитать — fail-closed для платного гейта (доступа нет), но честно сообщаем.
    return { configured: true, gated: true, active: false, priceUsd: SUB_PRICE_USD, error: 'read-failed' }
  }
}

/** Гейт для /plan: если подписка настроена и кошелёк не активен — вход платный. */
export async function requireSubscription(wallet) {
  const s = await subscriptionStatus(wallet)
  if (!s.gated) return { ok: true } // бета бесплатна
  if (s.active) return { ok: true }
  return { ok: false, status: s }
}
