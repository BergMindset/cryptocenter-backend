// Подписка на сервис пулов ($20/мес, on-chain permit-контракт PoolsSubscription на Base).
// КОНФИГ-УПРАВЛЯЕМО: пока SUBSCRIPTION_CONTRACT не задан в env — гейт ВЫКЛЮЧЕН, бета бесплатна.
// Контракт деплоит основатель ПОСЛЕ независимого аудита; сервис только ЧИТАЕТ статус (view).
import { parseAbi, encodeFunctionData, hexToBigInt } from 'viem'
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
  'function subscribeWithPermit(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function cancel()',
])
// USDC на Base (FiatTokenV2_2): eip712Domain() РЕВЕРТИТ (ERC-5267 нет), поэтому домен собираем
// вручную. name/version сверены с on-chain DOMAIN_SEPARATOR 17.07: name="USD Coin", version="2".
const USDC_ABI = parseAbi([
  'function version() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
])
const USDC_DOMAIN_NAME = 'USD Coin'

/**
 * Построить EIP-2612 permit для подписки: юзер подпишет офф-чейн (без газа) кап на ГОД (12 × price),
 * это и есть верхняя граница ущерба (кап allowance). Домен берём из USDC в рантайме (ERC-5267),
 * не хардкодим. Возвращаем typed data для eth_signTypedData_v4.
 */
export async function preparePermit(wallet) {
  if (!isConfigured()) throw new Error('подписка не сконфигурирована (контракт не задеплоен)')
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(wallet || ''))) throw new Error('некорректный адрес кошелька')
  const [version, nonce, price] = await Promise.all([
    client.readContract({ address: SUB_TOKEN, abi: USDC_ABI, functionName: 'version' }).catch(() => '2'),
    client.readContract({ address: SUB_TOKEN, abi: USDC_ABI, functionName: 'nonces', args: [wallet] }),
    client.readContract({ address: SUB_CONTRACT, abi: SUB_ABI, functionName: 'price' }),
  ])
  const value = price * 12n // годовой кап
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600) // ≤ 1 час (инвариант)
  const typedData = {
    domain: { name: USDC_DOMAIN_NAME, version: String(version || '2'), chainId: SUB_CHAIN_ID, verifyingContract: SUB_TOKEN },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner: wallet, spender: SUB_CONTRACT, value: value.toString(), nonce: nonce.toString(), deadline: deadline.toString() },
  }
  return { typedData, value: value.toString(), deadline: deadline.toString() }
}

/** Собрать неподписанную транзакцию subscribeWithPermit из permit-подписи юзера (ECDSA v,r,s). */
export function buildSubscribeTx(value, deadline, signature) {
  const sig = String(signature || '')
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('некорректная подпись permit')
  const r = ('0x' + sig.slice(2, 66))
  const s = ('0x' + sig.slice(66, 130))
  let v = Number(hexToBigInt('0x' + sig.slice(130, 132)))
  if (v < 27) v += 27 // нормализация (кошельки могут вернуть 0/1)
  const data = encodeFunctionData({
    abi: SUB_ABI,
    functionName: 'subscribeWithPermit',
    args: [BigInt(value), BigInt(deadline), v, r, s],
  })
  return { to: SUB_CONTRACT, data, value: '0', chainId: SUB_CHAIN_ID }
}

/** Собрать транзакцию отмены автопродления. */
export function buildCancelTx() {
  if (!isConfigured()) throw new Error('подписка не сконфигурирована')
  return { to: SUB_CONTRACT, data: encodeFunctionData({ abi: SUB_ABI, functionName: 'cancel', args: [] }), value: '0', chainId: SUB_CHAIN_ID }
}

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
