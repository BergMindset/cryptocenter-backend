// Тест автомата-комплаенса: хороший пост проходит, плохой ловится по всем правилам.
import { getFacts } from '../lib/factory/facts.mjs'
import { checkPost } from '../lib/factory/compliance.mjs'

const facts = await getFacts()
console.log('реестр фактов:', Object.keys(facts).filter((k) => !k.startsWith('_')).length,
  '| Центр жив:', facts._centerUp, '| NAV:', facts.navIndex?.value, '| NFT minted:', facts.tvMinted?.value)

const D = '$' // чтобы не мучиться с экранированием
const good = [
  'What can one TerraVault NFT become over 5 years?',
  `${D}500. ${D}250 to index, ${D}250 to real land (~1.29 ha of a 15,496 ha estate, 49-year lease). 12,000 NFT supply.`,
  'Split: 60% claim / 20% reinvest / 15% holders / 5% referral. Claim is MANUAL, press once per 24h.',
  `Model: body ${D}250 to ~${D}707, claimed ~${D}1,372, total ~${D}2,329 (model figure from fund accounting).`,
  'Returns are variable and not guaranteed. Not investment advice.',
].join('\n')

const seed = [
  'The Seed round is 84% filled. Here is the math — not a countdown.',
  `Price: ${D}0.05. Raised: ${D}2,451,100 / ${D}2,915,000 (84%). Participants: 279.`,
  `Pre-Seed ${D}1,875,000 / 321. Angel ${D}1,175,000 / 391. Total ${D}5.5M. Supply 1B YLDX.`,
  'NAV index 0.902, model annualized ~104% — model figure from fund accounting.',
  'Returns are variable and not guaranteed. Not investment advice.',
].join('\n')

const bad = [
  'GUARANTEED passive income! Hurry — last chance!',
  `Our fund manages ${D}611M across 4182 accounts, 33% APY. Auto-withdraw every day.`,
  'Just deposit and relax.',
].join('\n')

let fail = 0
for (const [name, post, wantPass] of [['GOOD-TerraSim', good, true], ['GOOD-Seed', seed, true], ['BAD', bad, false]]) {
  const r = checkPost(post, facts)
  const ok = r.pass === wantPass
  if (!ok) fail++
  console.log(`\n=== ${name} === pass:${r.pass} (want ${wantPass}) ${ok ? '✓' : '✗ ОШИБКА'} | level:${r.level} | цифр:${r.checkedNumbers}`)
  r.violations.forEach((x) => console.log(`  [${x.severity}] ${x.rule}: ${x.detail}`))
}
console.log(`\nИТОГ: ${fail === 0 ? 'ВСЕ ВЕРНО ✓' : fail + ' ошибок ✗'}`)
process.exit(fail ? 1 : 0)
