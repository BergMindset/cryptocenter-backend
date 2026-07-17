// Контент-фабрика · РЕЕСТР ФАКТОВ (facts registry) — единственный разрешённый источник цифр для постов.
// Живые метрики тянутся из Центра admin.bergapp.com; выверенные константы (пресейл/продукты) — курируются вручную.
// Комплаенс-автомат сверяет КАЖДУЮ цифру поста с этим реестром; чего нет здесь — «выдуманное число».
// Урок GLASS ENGINE: 0 цифр мимо реестра. Урок cat1: состояние в БД, не в файле (позже; пока in-memory кэш).

const CENTER = {
  pool: 'https://admin.bergapp.com/api/pool-analytics',
  eco: 'https://admin.bergapp.com/api/ecosystem',
  signal: 'https://admin.bergapp.com/api/public/index-signal',
}

async function safeJson(url, ms = 8000) {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), ms)
    const r = await fetch(url, { signal: c.signal })
    clearTimeout(t)
    return r.ok ? await r.json() : null
  } catch { return null }
}

// Выверенные константы (не из Центра): пресейл (yldx.ai), параметры продуктов, земля.
// Обновлять здесь при изменении раунда. Каждая — с источником и датой сверки.
export const CURATED_FACTS = {
  // Пресейл YLDX (сверено с yldx.ai 14.07, ДВИГАЕТСЯ — обновлять перед Seed-постами)
  seedRaised: { value: 2451100, unit: 'usd', label: 'Seed raised', source: 'yldx.ai', asOf: '2026-07-14' },
  seedTarget: { value: 2915000, unit: 'usd', label: 'Seed target', source: 'yldx.ai', asOf: '2026-07-14' },
  seedPct: { value: 84, unit: 'pct', label: 'Seed filled %', source: 'yldx.ai', asOf: '2026-07-14' },
  seedParticipants: { value: 279, unit: 'count', label: 'Seed participants', source: 'yldx.ai', asOf: '2026-07-14' },
  seedPrice: { value: 0.05, unit: 'usd', label: 'Seed price', source: 'yldx.ai', asOf: '2026-07-14' },
  angelRaised: { value: 1175000, unit: 'usd', label: 'Angel raised', source: 'yldx.ai', asOf: '2026-07-14' },
  angelParticipants: { value: 391, unit: 'count', label: 'Angel participants', source: 'yldx.ai', asOf: '2026-07-14' },
  preseedRaised: { value: 1875000, unit: 'usd', label: 'Pre-Seed raised', source: 'yldx.ai', asOf: '2026-07-14' },
  preseedParticipants: { value: 321, unit: 'count', label: 'Pre-Seed participants', source: 'yldx.ai', asOf: '2026-07-14' },
  totalRaised: { value: 5500000, unit: 'usd', label: 'Total raised', source: 'yldx.ai', asOf: '2026-07-14' },
  // Трек-рекорд
  trackDays: { value: 1491, unit: 'count', label: 'Daily NAV points', source: 'fund ledger', asOf: '2026-07-16' },
  trackStart: { value: 2022, unit: 'year', label: 'Pools live since', source: 'fund ledger', asOf: '2026-07-16' },
  // TerraVault / земля (продуктовые константы)
  nftPrice: { value: 500, unit: 'usd', label: 'TerraVault NFT price', source: 'product spec' },
  nftIndexHalf: { value: 250, unit: 'usd', label: 'NFT → index half', source: 'product spec' },
  nftLandHalf: { value: 250, unit: 'usd', label: 'NFT → land half', source: 'product spec' },
  nftHectares: { value: 1.29, unit: 'ha', label: 'Land per NFT', source: 'product spec' },
  estateHectares: { value: 15496, unit: 'ha', label: 'Estate size', source: 'product spec' },
  lease: { value: 49, unit: 'year', label: 'Lease term', source: 'product spec' },
  // Сплит дохода TerraSim
  splitClaim: { value: 60, unit: 'pct', label: 'Claim %', source: 'product spec' },
  splitReinvest: { value: 20, unit: 'pct', label: 'Reinvest %', source: 'product spec' },
  splitHolders: { value: 15, unit: 'pct', label: '$YLDX holders %', source: 'product spec' },
  splitRef: { value: 5, unit: 'pct', label: 'Referral %', source: 'product spec' },
  // Модельный пример $500/5лет (сверено симуляцией 17.07)
  ex5yBody: { value: 707, unit: 'usd', label: '5y body (model)', source: 'model', model: true },
  ex5yClaimed: { value: 1372, unit: 'usd', label: '5y claimed (model)', source: 'model', model: true },
  ex5yCapital: { value: 957, unit: 'usd', label: '5y capital (model)', source: 'model', model: true },
  ex5yTotal: { value: 2329, unit: 'usd', label: '5y total (model)', source: 'model', model: true },
  // Методология
  ruleCap: { value: 2.5, unit: 'pct', label: 'Per-pool cap', source: 'methodology' },
  ruleIl: { value: 25, unit: 'pct', label: 'IL cap', source: 'methodology' },
  ruleHold: { value: 14, unit: 'month', label: 'Min hold', source: 'methodology' },
  ruleTvl: { value: 1000000, unit: 'usd', label: 'Min pool TVL', source: 'methodology' },
  navBase: { value: 1000, unit: 'usd', label: 'NAV base', source: 'fund' },
}

let cache = null
let cacheAt = 0

/** Собрать полный реестр фактов: живые из Центра + курируемые. Кэш 60с. */
export async function getFacts() {
  if (cache && Date.now() - cacheAt < 60000) return cache
  const [pool, eco, sig] = await Promise.all([safeJson(CENTER.pool), safeJson(CENTER.eco), safeJson(CENTER.signal)])
  const live = {}
  if (sig?.ok && sig.index) {
    live.navIndex = { value: +sig.index.current, unit: 'index', label: 'NAV index (live)', source: 'Center', live: true }
    live.navApy = { value: +sig.index.apy, unit: 'pct', label: 'NAV APY (model)', source: 'Center', model: true }
  }
  if (eco?.projects) {
    const p = eco.projects
    if (p.yldx?.supply) live.supply = { value: p.yldx.supply, unit: 'count', label: 'YLDX supply', source: 'Center', live: true }
    if (p.terravault) {
      live.tvMinted = { value: p.terravault.minted, unit: 'count', label: 'NFT minted', source: 'Center', live: true }
      live.tvMax = { value: p.terravault.maxSupply, unit: 'count', label: 'NFT max supply', source: 'Center', live: true }
      live.tvRaised = { value: p.terravault.raised, unit: 'usd', label: 'TerraVault raised', source: 'Center', live: true }
      if (p.terravault.apy != null) live.tvApy = { value: p.terravault.apy, unit: 'pct', label: 'TerraVault APY (model)', source: 'Center', model: true }
    }
    if (p.support?.tickets) live.tickets = { value: p.support.tickets, unit: 'count', label: 'Support tickets', source: 'Center', live: true }
  }
  if (pool?.chainsCount) live.chains = { value: pool.chainsCount, unit: 'count', label: 'Chains analyzed', source: 'Center', live: true }

  cache = { ...CURATED_FACTS, ...live, _generatedAt: new Date().toISOString(), _centerUp: !!(pool || eco || sig) }
  cacheAt = Date.now()
  return cache
}

/** Множество допустимых числовых значений (нормализованных) для сверки цифр поста. */
export function allowedNumbers(facts) {
  const set = new Set()
  for (const [k, f] of Object.entries(facts)) {
    if (k.startsWith('_') || typeof f?.value !== 'number') continue
    set.add(f.value)
    // допускаем короткие формы: 5.5M, 2.45M, 1B, 12000/12,000, проценты
    if (f.unit === 'usd' && f.value >= 1e6) set.add(+(f.value / 1e6).toFixed(2))
    if (f.unit === 'count' && f.value >= 1e9) set.add(+(f.value / 1e9).toFixed(0))
  }
  return set
}

/** Какие факты помечены как модельные (для проверки меток «model»). */
export function modelValues(facts) {
  const set = new Set()
  for (const f of Object.values(facts)) if (f?.model && typeof f.value === 'number') set.add(f.value)
  return set
}
