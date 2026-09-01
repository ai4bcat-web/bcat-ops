#!/usr/bin/env node
/**
 * Chad's pay-rate change (decided 2026-09-01):
 *   • weeks of 2026-08-16 and 2026-08-23 → Lee/Roy model: 88% of gross, THEN − expenses
 *   • weeks < 2026-08-16 stay on his old 42% after expenses (pinned so history can't drift)
 *   • week of 2026-08-30 onward → back to his normal model at 50% AFTER expenses
 *
 * Writes it as: base setting = 50% / after-expenses, with rateHistory windows pinning
 * the past (see PayRateOverride in src/lib/driverPay.ts). Then recomputes and prints
 * the two 88% weeks exactly as the Driver Pay page will (trips + fixed expenses +
 * EFS fuel + one-off deductions) so the numbers can be checked before sheets go out.
 *
 * Usage:
 *   BCAT_EMAIL=you@bcatcorp.com BCAT_PASSWORD=... node scripts/setChadPayRates.mjs [--dry-run]
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')
const outputs = JSON.parse(readFileSync(resolve(__dirname, '../amplify_outputs.json'), 'utf8'))
Amplify.configure(outputs)

const WEEKS_88 = ['2026-08-16', '2026-08-23']
const RATE_HISTORY = [
  { from: '1970-01-01', until: '2026-08-16', payPercent: 0.42, expensesBeforePercent: true },
  { from: '2026-08-16', until: '2026-08-30', payPercent: 0.88, expensesBeforePercent: false },
]
const NEW_BASE = { payPercent: 0.5, expensesBeforePercent: true }

async function gql(query, variables, idToken) {
  const res = await fetch(outputs.data.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: idToken },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors))
  return json.data
}

// ── mirrors src/lib/driverFuel.ts ────────────────────────────────────────────
const normCard = (c) => (c ?? '').replace(/\D/g, '').replace(/^0+/, '')
const FUEL_TYPES = new Set(['ULSD', 'FUEL', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])
const isFuel = (tx) => {
  const cat = (tx.itemCategory ?? '').trim()
  return cat ? cat === 'FUEL' : FUEL_TYPES.has((tx.fuelType ?? '').toUpperCase().trim())
}
const fuelKey = (tx) => `${tx.transactionDate}|${normCard(tx.cardNumber)}|${tx.fuelType}|${tx.amount}|${tx.quantity}`
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function listAll(idToken, name, fields, filterStr = '') {
  let items = [], nextToken = null
  do {
    const d = await gql(
      `query L($nextToken: String) { ${name}(limit: 1000, nextToken: $nextToken${filterStr}) { items { ${fields} } nextToken } }`,
      { nextToken }, idToken)
    items = items.concat(d[name].items ?? [])
    nextToken = d[name].nextToken
  } while (nextToken)
  return items
}

const { isSignedIn } = await signIn({ username: process.env.BCAT_EMAIL, password: process.env.BCAT_PASSWORD })
if (!isSignedIn) throw new Error('sign-in failed')
const idToken = (await fetchAuthSession()).tokens.idToken.toString()

// ── find Chad's Amazon pay setting ───────────────────────────────────────────
const drivers = await listAll(idToken, 'listDrivers', 'id name active fleetGroup')
const chads = drivers.filter((d) => /\bchad\b/i.test(d.name) && d.active !== false)
if (chads.length !== 1) throw new Error(`expected exactly one active Chad, found: ${chads.map((d) => d.name).join(', ') || 'none'}`)
const chad = chads[0]

const settings = await listAll(idToken, 'listDriverPaySettings',
  'id driverId payGroup payPercent expensesBeforePercent fuelCardNumber fixedExpenses rateHistory active')
const setting = settings.find((s) => s.driverId === chad.id && (s.payGroup ?? 'AMAZON') === 'AMAZON')
if (!setting) throw new Error(`no AMAZON pay setting found for ${chad.name}`)
const unwrap = (v) => { for (let i = 0; i < 4 && typeof v === 'string'; i++) { try { v = JSON.parse(v) } catch { break } } return v }
const fixed = unwrap(setting.fixedExpenses) ?? []

console.log(`${chad.name} — current setting: ${Math.round(setting.payPercent * 100)}% ${setting.expensesBeforePercent ? 'AFTER expenses' : 'of gross − expenses'}`)
console.log(`→ new base: 50% AFTER expenses; pinned: <8/16 @ 42% after-exp, 8/16–8/29 @ 88% − expenses\n`)

// ── recompute the two 88% weeks the way the page will ────────────────────────
const trips = await listAll(idToken, 'listAmazonTrips', 'id driverId periodStart loadId freightAmount status')
const oneOffs = await listAll(idToken, 'listDriverPayDeductions', 'id driverId periodStart label amount')
const fuelTxs = await listAll(idToken, 'listFuelTransactions', 'id transactionDate cardNumber fuelType itemCategory amount quantity')

for (const week of WEEKS_88) {
  const end = new Date(`${week}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 6)
  const endIso = end.toISOString().slice(0, 10)
  const wTrips = trips.filter((t) => t.driverId === chad.id && t.periodStart === week)
  const gross = r2(wTrips.reduce((s, t) => s + (t.freightAmount || 0), 0))

  const seen = new Set()
  const fuel = r2(fuelTxs
    .filter((tx) => normCard(tx.cardNumber) === normCard(setting.fuelCardNumber) && isFuel(tx)
      && tx.transactionDate >= week && tx.transactionDate <= endIso)
    .filter((tx) => { const k = fuelKey(tx); if (seen.has(k)) return false; seen.add(k); return true })
    .reduce((s, tx) => s + (tx.amount || 0), 0))

  const wOneOffs = oneOffs.filter((o) => o.driverId === chad.id && o.periodStart === week)
  const fixedTotal = r2(fixed.reduce((s, f) => s + (f.amount || 0), 0))
  const oneOffTotal = r2(wOneOffs.reduce((s, o) => s + (o.amount || 0), 0))
  const expenses = r2(fixedTotal + fuel + oneOffTotal)

  const driverShare = r2(0.88 * gross)
  const check = r2(driverShare - expenses)
  console.log(`Week ${week} – ${endIso}  (${wTrips.length} trips)`)
  console.log(`  Gross freight              ${money(gross)}`)
  console.log(`  Driver share (88%)         ${money(driverShare)}`)
  console.log(`  Expenses                  −${money(expenses)}  (fixed ${money(fixedTotal)} + fuel ${money(fuel)} + one-offs ${money(oneOffTotal)})`)
  console.log(`  CHECK                      ${money(check)}\n`)
}

if (DRY_RUN) { console.log('[dry-run] setting NOT updated'); process.exit(0) }

await gql(
  `mutation U($input: UpdateDriverPaySettingInput!) { updateDriverPaySetting(input: $input) { id payPercent expensesBeforePercent rateHistory } }`,
  { input: { id: setting.id, ...NEW_BASE, rateHistory: JSON.stringify(RATE_HISTORY) } }, idToken)
console.log(`✔ ${chad.name}'s pay setting updated: base 50% after expenses + pinned rate windows written.`)
