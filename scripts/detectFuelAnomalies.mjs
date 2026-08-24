#!/usr/bin/env node
/**
 * Fuel Price Anomaly Detector — flags overpay fuel transactions >15% above fleet average.
 *
 * READ-ONLY. Queries the bcat-ops AppSync GraphQL API for fuel transactions (last 30 days),
 * computes fleet average price/gallon per fuel type, and flags any transaction where
 * pricePerUnit exceeds 15% above the fleet average.
 *
 * Auth: Cognito signIn via aws-amplify (same auth as iv1 ingestFuelReport.mjs).
 *
 * Usage:
 *   source ~/.hermes/bcat-ops-credentials.env
 *   node scripts/detectFuelAnomalies.mjs [--threshold 15] [--days 30] [--json] [--slack] [--post-to-slack]
 *
 * Flags:
 *   --threshold N    Overpay threshold percent (default: 15)
 *   --days N          Lookback window in days (default: 30)
 *   --json            Output raw JSON instead of formatted text
 *   --slack           Output Slack-formatted markdown message to stdout
 *   --post-to-slack   POST the Slack message via SLACK_WEBHOOK_URL env var
 *
 * For cron: wrapper at ~/.hermes/scripts/fuel-anomaly-check.sh (cron id: aa33291bf992)
 */

import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Amplify config ─────────────────────────────────────────────────────────────
const outputs = JSON.parse(readFileSync(resolve(__dirname, '../amplify_outputs.json'), 'utf8'))
const APPSYNC_URL = outputs.data.url
Amplify.configure(outputs)

// Fuel types recognized as real fuel (matches driverFuel.ts FUEL_ITEM_TYPES)
const FUEL_ITEM_TYPES = new Set(['ULSD', 'FUEL', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])

// ── GraphQL ────────────────────────────────────────────────────────────────────
const LIST_FUEL_QUERY = `query ListFuelTransactions($filter: ModelFuelTransactionFilterInput) {
  listFuelTransactions(limit: 10000, filter: $filter) {
    items {
      id transactionDate cardNumber invoiceNumber unitNumber truckId driverName
      odometer locationName city state fees fuelType itemCategory pricePerUnit quantity amount
      currency sourceFile importedAt createdAt updatedAt
    }
  }
}`

const LIST_ALL_QUERY = `query ListFuelTransactions {
  listFuelTransactions(limit: 10000) {
    items {
      id transactionDate cardNumber invoiceNumber unitNumber truckId driverName
      odometer locationName city state fees fuelType itemCategory pricePerUnit quantity amount
      currency sourceFile importedAt createdAt updatedAt
    }
  }
}`

async function callAppSync(query, variables, idToken) {
  const res = await fetch(APPSYNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: idToken },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}

// ── Fuel detection (mirrors driverFuel.ts) ─────────────────────────────────────
function isFuelTx(tx) {
  const cat = (tx.itemCategory || '').trim()
  if (cat) return cat === 'FUEL'
  return FUEL_ITEM_TYPES.has((tx.fuelType || '').toUpperCase().trim())
}

function normalizeCard(card) {
  return (card || '').replace(/\D/g, '').replace(/^0+/, '')
}

// ── Main logic ─────────────────────────────────────────────────────────────────
async function fetchFuelTransactions(idToken, days) {
  const endDate = new Date()
  const startDate = new Date(endDate - days * 86400000)
  const startIso = startDate.toISOString().slice(0, 10)
  const endIso = endDate.toISOString().slice(0, 10)

  // Try with date filter first; fall back to unfiltered
  for (const [query, variables] of [
    [LIST_FUEL_QUERY, { filter: { transactionDate: { between: [startIso, endIso] } } }],
    [LIST_ALL_QUERY, {}],
  ]) {
    try {
      const result = await callAppSync(query, variables, idToken)
      if (result.errors) {
        const msg = result.errors[0].message
        if (variables.filter && (msg.includes('filter') || msg.includes('between'))) {
          console.warn('[warn] Filter not supported by backend, retrying unfiltered...')
          continue
        }
        throw new Error(`GraphQL error: ${msg}`)
      }
      let items = result.data.listFuelTransactions.items || []

      // If unfiltered, filter client-side
      if (!variables.filter && days) {
        items = items.filter(tx => tx.transactionDate >= startIso && tx.transactionDate <= endIso)
      }

      // Filter to fuel only
      return items.filter(isFuelTx)
    } catch (err) {
      if (variables.filter) {
        console.warn(`[warn] Filtered query failed (${err.message}), retrying unfiltered...`)
        continue
      }
      throw err
    }
  }
  throw new Error('Failed to fetch fuel transactions')
}

function dedupTransactions(txs) {
  const seen = new Set()
  return txs.filter(tx => {
    const key = `${tx.transactionDate}|${tx.cardNumber}|${tx.fuelType}|${tx.amount}|${tx.quantity}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function detectAnomalies(txs, thresholdPct) {
  // Group by fuel type
  const byType = {}
  for (const tx of txs) {
    const ft = (tx.fuelType || 'UNKNOWN').toUpperCase().trim()
    if (!byType[ft]) byType[ft] = []
    byType[ft].push(tx)
  }

  // Fleet averages
  const fleetAverages = {}
  for (const [ft, group] of Object.entries(byType)) {
    const prices = group.map(tx => tx.pricePerUnit).filter(p => p > 0)
    const avg = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0
    const totalGallons = group.reduce((s, tx) => s + (tx.quantity || 0), 0)
    fleetAverages[ft] = {
      avg_price_per_unit: Math.round(avg * 10000) / 10000,
      count: group.length,
      total_gallons: Math.round(totalGallons * 100) / 100,
    }
  }

  // Flag overpay transactions
  const flags = []
  for (const tx of txs) {
    const ft = (tx.fuelType || 'UNKNOWN').toUpperCase().trim()
    const ppu = tx.pricePerUnit || 0
    const fleetAvg = fleetAverages[ft]?.avg_price_per_unit || 0

    if (fleetAvg <= 0 || ppu <= 0) continue

    const overpayPct = ((ppu - fleetAvg) / fleetAvg) * 100
    if (overpayPct > thresholdPct) {
      const overpayAmount = Math.round((ppu - fleetAvg) * (tx.quantity || 0) * 100) / 100
      flags.push({
        id: tx.id,
        transaction_date: tx.transactionDate,
        truck_unit: tx.unitNumber || (tx.cardNumber ? `TRK-${normalizeCard(tx.cardNumber)}` : 'Unknown'),
        truck_id: tx.truckId,
        driver: tx.driverName || '',
        location: [tx.city, tx.state].filter(Boolean).join(' '),
        fuel_type: ft,
        price_per_gallon: ppu,
        fleet_average: Math.round(fleetAvg * 10000) / 10000,
        overpay_pct: Math.round(overpayPct * 100) / 100,
        overpay_amount: overpayAmount,
        gallons: tx.quantity || 0,
        total_cost: tx.amount || 0,
      })
    }
  }

  flags.sort((a, b) => b.overpay_pct - a.overpay_pct)

  return {
    fleet_averages: fleetAverages,
    flags,
    summary: {
      total_transactions: txs.length,
      total_flagged: flags.length,
      threshold_pct: thresholdPct,
    },
  }
}

function formatSlackMessage(results) {
  const { flags, summary, fleet_averages } = results
  const today = new Date().toISOString().slice(0, 10)

  if (!flags.length) {
    return `:fuelpump: *Fuel Anomaly Report* — ${today}\n` +
      `✅ No overpay transactions detected (>15% above fleet average).\n` +
      `_${summary.total_transactions} transactions analyzed across ${Object.keys(fleet_averages).length} fuel types._`
  }

  const lines = [
    `:warning: *Fuel Anomaly Report* — ${today}`,
    `*${flags.length} overpay transaction(s)* detected (>15% above fleet average) out of ${summary.total_transactions} analyzed.\n`,
  ]

  for (const f of flags) {
    lines.push(
      `• *${f.truck_unit}*: $${f.price_per_gallon.toFixed(2)}/gal in ${f.location || 'Unknown location'}` +
      ` — ${Math.round(f.overpay_pct)}% above fleet avg ($${f.fleet_average.toFixed(2)}/gal).` +
      ` Overpay: $${f.overpay_amount.toFixed(2)}`
    )
  }

  lines.push('\n*Fleet Averages (30-day):*')
  for (const [ft, info] of Object.entries(fleet_averages).sort()) {
    lines.push(`  • ${ft}: $${info.avg_price_per_unit.toFixed(2)}/gal (${info.count} txns, ${info.total_gallons.toFixed(1)} gal)`)
  }

  return lines.join('\n')
}

// ── Slack posting (optional) ───────────────────────────────────────────────────
async function postToSlack(text) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    console.error('[warn] SLACK_WEBHOOK_URL not set — cannot post to Slack.')
    console.error('       Set it to a Slack Incoming Webhook URL to enable auto-posting.')
    return { ok: false, error: 'No webhook URL configured' }
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      console.error(`[warn] Slack webhook returned ${res.status} ${res.statusText}`)
      return { ok: false, error: `HTTP ${res.status}` }
    }
    console.error('[ok] Posted to Slack.')
    return { ok: true }
  } catch (err) {
    console.error(`[warn] Slack webhook failed: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--threshold' && argv[i + 1]) { args.threshold = parseFloat(argv[++i]) }
    else if (a === '--days' && argv[i + 1]) { args.days = parseInt(argv[++i], 10) }
    else if (a === '--json') { args.json = true }
    else if (a === '--slack') { args.slack = true }
    else if (a === '--post-to-slack') { args.postToSlack = true }
    else if (!a.startsWith('--') && !args.threshold) { args.threshold = parseFloat(a) } // positional threshold (backwards-compat)
  }
  return args
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))
  const threshold = cli.threshold || 15
  const days = cli.days || 30
  const jsonOut = cli.json || false
  const slackOut = cli.slack || false
  const doPost = cli.postToSlack || false

  const email = process.env.BCAT_EMAIL
  const password = process.env.BCAT_PASSWORD
  if (!email || !password) {
    console.error('Error: BCAT_EMAIL and BCAT_PASSWORD environment variables are required.')
    console.error('       Source them from ~/.hermes/bcat-ops-credentials.env')
    process.exit(1)
  }

  console.error(`Authenticating as ${email}...`)
  await signIn({ username: email, password })
  const session = await fetchAuthSession()
  const idToken = session.tokens?.idToken?.toString()
  if (!idToken) {
    console.error('No ID token after sign-in')
    process.exit(1)
  }

  console.error(`Fetching fuel transactions (last ${days} days)...`)
  const txs = await fetchFuelTransactions(idToken, days)
  console.error(`  Fetched ${txs.length} fuel transactions.`)

  const deduped = dedupTransactions(txs)
  if (deduped.length < txs.length) {
    console.error(`  De-duplicated: ${txs.length} → ${deduped.length} unique.`)
  }

  if (!deduped.length) {
    console.error('No fuel transactions found in the lookback window.')
    if (jsonOut) console.log(JSON.stringify({ fleet_averages: {}, flags: [], summary: { total_transactions: 0, total_flagged: 0 } }))
    else console.log('No fuel transactions found in the lookback window.')
    return
  }

  const results = detectAnomalies(deduped, threshold)

  if (jsonOut) {
    console.log(JSON.stringify(results, null, 2))
  } else if (slackOut || doPost) {
    const slackMsg = formatSlackMessage(results)
    if (slackOut) console.log(slackMsg)
    if (doPost) await postToSlack(slackMsg)
  } else {
    // Human-readable
    console.log(`\nFuel Anomaly Detection Report`)
    console.log(`=============================`)
    console.log(`Period: last ${days} days`)
    console.log(`Transactions analyzed: ${results.summary.total_transactions}`)
    console.log(`Threshold: ${threshold}% above fleet average`)
    console.log(`Flagged: ${results.summary.total_flagged}`)
    console.log()

    console.log('Fleet Averages (price/gallon):')
    for (const [ft, info] of Object.entries(results.fleet_averages).sort()) {
      console.log(`  ${ft.padEnd(6)}: $${info.avg_price_per_unit.toFixed(4)}/gal  (${info.count} txns, ${info.total_gallons.toFixed(1)} gal)`)
    }

    if (results.flags.length) {
      console.log(`\n⚠️  Flagged Overpay Transactions (>${threshold}% above fleet average):`)
      for (const f of results.flags) {
        console.log(
          `  ${(f.truck_unit || '').padEnd(12)} | ${f.transaction_date} | ` +
          `${(f.location || '').padEnd(30)} | $${f.price_per_gallon.toFixed(2)}/gal | ` +
          `+${f.overpay_pct.toFixed(1)}% | overpay: $${f.overpay_amount.toFixed(2)} | ` +
          `${f.gallons.toFixed(1)} gal | $${f.total_cost.toFixed(2)} total`
        )
      }
    } else {
      console.log(`\n✅ No overpay transactions detected.`)
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})