#!/usr/bin/env node
/**
 * HOS / ELD Compliance Watchdog — queries bcat-ops for driver compliance alerts,
 * tracks 7-day rolling violation counts, and posts violations to Slack.
 *
 * READ-ONLY. Queries the bcat-ops AppSync GraphQL API for:
 *   - ComplianceAlert records (unacknowledged, CRITICAL/EXPIRED)
 *   - Driver records with NON_COMPLIANT/EXPIRING_SOON complianceStatus
 * Tracks daily violation counts per driver in a 7-day rolling state file.
 *
 * Auth: Cognito signIn via aws-amplify (same auth as detectFuelAnomalies.mjs).
 *
 * Usage:
 *   source ~/.hermes/bcat-ops-credentials.env
 *   node scripts/detectHosViolations.mjs [--json] [--slack] [--quiet]
 *
 * State file: ~/.hermes/state/hos-watchdog-state.json
 *
 * For cron: wrapper at ~/.hermes/scripts/hos-watchdog.sh
 */

import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOME = homedir()

// ── Amplify config ─────────────────────────────────────────────────────────────
const outputs = JSON.parse(readFileSync(resolve(__dirname, '../amplify_outputs.json'), 'utf8'))
const APPSYNC_URL = outputs.data.url
Amplify.configure(outputs)

// State file for 7-day rolling violation tracking
const STATE_FILE = `${HOME}/.hermes/state/hos-watchdog-state.json`

// ── GraphQL ────────────────────────────────────────────────────────────────────
const LIST_ALERTS_QUERY = `query ListComplianceAlerts {
  listComplianceAlerts(limit: 1000) {
    items {
      id entityType entityId entityName documentType documentTitle
      complianceDocumentId expirationDate severity acknowledged
      acknowledgedBy acknowledgedAt resolvedAt createdAt updatedAt
    }
  }
}`

const LIST_DRIVERS_QUERY = `query ListDrivers {
  listDrivers(limit: 200) {
    items {
      id name active type onboardingStatus complianceStatus
      cdl cdlExpiration medCardExpiration hireDate
      assignedTruckId email phone createdAt updatedAt
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

// ── State file management ──────────────────────────────────────────────────────

import { writeFileSync, existsSync, mkdirSync } from 'fs'

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    } catch {
      // corrupt file, start fresh
    }
  }
  return { daily_counts: {}, last_updated: null }
}

function saveState(state) {
  const dir = resolve(STATE_FILE, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  state.last_updated = new Date().toISOString()
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function updateRollingCounts(state, todayIso, violationDrivers) {
  const daily = state.daily_counts || {}
  daily[todayIso] = {
    drivers: [...violationDrivers].sort(),
    count: violationDrivers.size,
  }
  // Prune older than 7 days
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 7)
  const cutoffIso = cutoff.toISOString().slice(0, 10)
  const pruned = {}
  for (const [date, data] of Object.entries(daily)) {
    if (date >= cutoffIso) pruned[date] = data
  }
  state.daily_counts = pruned
  return state
}

function compute7DaySummary(state) {
  const daily = state.daily_counts || {}
  const driverDays = {}
  let totalViolationDays = 0

  for (const [date, dayData] of Object.entries(daily).sort()) {
    const drivers = dayData.drivers || []
    totalViolationDays += drivers.length
    for (const name of drivers) {
      driverDays[name] = (driverDays[name] || 0) + 1
    }
  }

  const sorted = Object.entries(driverDays)
    .sort(([, a], [, b]) => b - a)
    .reduce((acc, [name, days]) => { acc[name] = days; return acc }, {})

  return {
    total_violation_days: totalViolationDays,
    drivers: sorted,
    days_tracked: Object.keys(daily).length,
  }
}

// ── Violation detection ────────────────────────────────────────────────────────

function detectViolations(drivers, alerts) {
  const today = new Date().toISOString().slice(0, 10)

  // Non-compliant / expiring-soon drivers
  const nonCompliant = []
  for (const d of drivers) {
    if (!d.active) continue
    const cs = d.complianceStatus || 'UNKNOWN'
    if (cs === 'NON_COMPLIANT' || cs === 'EXPIRING_SOON') {
      nonCompliant.push({
        name: d.name || 'Unknown',
        driver_id: d.id,
        status: cs,
        driver_type: d.type || 'UNCLASSIFIED',
        cdl_expiration: d.cdlExpiration || null,
        med_card_expiration: d.medCardExpiration || null,
        assigned_truck_id: d.assignedTruckId || null,
        phone: d.phone || null,
      })
    }
  }

  // Unacknowledged severe alerts (driver only)
  const severeAlerts = []
  for (const a of alerts) {
    if (a.acknowledged) continue
    if (a.resolvedAt) continue
    if (a.entityType !== 'DRIVER') continue
    const sev = a.severity || ''
    if (sev !== 'CRITICAL' && sev !== 'EXPIRED') continue
    severeAlerts.push({
      driver_name: a.entityName || 'Unknown',
      driver_id: a.entityId,
      alert_id: a.id,
      document_type: a.documentType,
      document_title: a.documentTitle || null,
      expiration_date: a.expirationDate || null,
      severity: sev,
      created_at: a.createdAt || null,
    })
  }

  // Combined violation set
  const violationNames = new Set()
  const violationDetails = []

  for (const d of nonCompliant) {
    violationNames.add(d.name)
    violationDetails.push({
      driver: d.name,
      type: 'compliance_status',
      detail: `Status: ${d.status}`,
      driver_type: d.driver_type,
      cdl_exp: d.cdl_expiration,
      med_exp: d.med_card_expiration,
    })
  }

  const seenAlertKeys = new Set()
  for (const a of severeAlerts) {
    const name = a.driver_name
    if (!violationNames.has(name)) violationNames.add(name)
    const key = `${name}|${a.document_type}`
    if (!seenAlertKeys.has(key)) {
      seenAlertKeys.add(key)
      const expStr = a.expiration_date ? a.expiration_date.slice(0, 10) : 'N/A'
      violationDetails.push({
        driver: name,
        type: 'document_alert',
        detail: `${a.severity}: ${a.document_title || a.document_type} (expires ${expStr})`,
        alert_id: a.alert_id,
      })
    }
  }

  const activeCount = drivers.filter(d => d.active).length

  return {
    violation_drivers: [...violationNames].sort(),
    violation_count: violationNames.size,
    non_compliant: nonCompliant,
    severe_alerts: severeAlerts,
    violations: violationDetails,
    total_drivers: activeCount,
  }
}

// ── Slack message formatting ───────────────────────────────────────────────────

function colorForSeverity(severity) {
  if (severity === 'EXPIRED') return '🔴'
  if (severity === 'CRITICAL') return '🟠'
  if (severity === 'URGENT') return '🟡'
  return '⚪'
}

function emojiForTotal(total) {
  if (total === 0) return '✅'
  if (total <= 2) return '⚠️'
  return '🚨'
}

function format7DaySummary(summary) {
  const lines = [
    '*7-Day Rolling Violation Count:*',
    `  • Total violation-days: ${summary.total_violation_days}`,
    `  • Days tracked: ${summary.days_tracked}`,
  ]
  const drivers = Object.entries(summary.drivers)
  if (drivers.length > 0) {
    lines.push('  • Per-driver breakdown:')
    for (const [name, days] of drivers) {
      const bar = '█'.repeat(days)
      lines.push(`    ${name}: ${days}d ${bar}`)
    }
  } else {
    lines.push('  • No violations in the last 7 days. 🎉')
  }
  return lines.join('\n')
}

function formatSlackMessage(results, summary7d) {
  const today = new Date().toISOString().slice(0, 10)
  const vcount = results.violation_count
  const lines = [
    `${emojiForTotal(vcount)} *HOS / ELD Compliance Watchdog* — ${today}`,
  ]

  if (vcount === 0) {
    lines.push('✅ No HOS compliance violations detected in the last 24 hours.')
    lines.push(`_${results.total_drivers} active drivers monitored._`)
    lines.push('')
    lines.push(format7DaySummary(summary7d))
    return lines.join('\n')
  }

  lines.push(
    `*${vcount} driver(s)* with compliance issues detected ` +
    `(out of ${results.total_drivers} active).`
  )
  lines.push('')

  // Per-driver violation details
  for (const v of results.violations) {
    lines.push(`• *${v.driver}*: ${v.detail}`)
  }

  // Non-compliant drivers
  if (results.non_compliant.length) {
    lines.push('')
    lines.push('*Non-Compliant / Expiring Drivers:*')
    for (const d of results.non_compliant) {
      const extras = []
      if (d.cdl_expiration) extras.push(`CDL: ${d.cdl_expiration}`)
      if (d.med_card_expiration) extras.push(`Med: ${d.med_card_expiration}`)
      const extrasStr = extras.length ? ` ${extras.join(' | ')}` : ''
      lines.push(`  • ${d.name} — ${d.status} (${d.driver_type})${extrasStr}`)
    }
  }

  // Severe alerts
  if (results.severe_alerts.length) {
    lines.push('')
    lines.push('*Unacknowledged CRITICAL / EXPIRED Alerts (last 24h):*')
    const shown = results.severe_alerts.slice(0, 10)
    for (const a of shown) {
      const exp = a.expiration_date ? a.expiration_date.slice(0, 10) : '?'
      lines.push(
        `  ${colorForSeverity(a.severity)} ${a.driver_name}: ` +
        `${a.document_title || a.document_type} expires ${exp}`
      )
    }
    if (results.severe_alerts.length > 10) {
      lines.push(`  … +${results.severe_alerts.length - 10} more`)
    }
  }

  lines.push('')
  lines.push(format7DaySummary(summary7d))

  return lines.join('\n')
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {}
  for (const a of argv) {
    if (a === '--json') args.json = true
    else if (a === '--slack') args.slack = true
    else if (a === '--quiet') args.quiet = true
  }
  return args
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))

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

  console.error('Fetching drivers...')
  const driversResult = await callAppSync(LIST_DRIVERS_QUERY, {}, idToken)
  if (driversResult.errors) throw new Error(`GraphQL error: ${driversResult.errors[0].message}`)
  const drivers = driversResult.data.listDrivers.items || []
  console.error(`  Fetched ${drivers.length} driver records.`)

  console.error('Fetching compliance alerts...')
  const alertsResult = await callAppSync(LIST_ALERTS_QUERY, {}, idToken)
  if (alertsResult.errors) throw new Error(`GraphQL error: ${alertsResult.errors[0].message}`)
  const alerts = alertsResult.data.listComplianceAlerts.items || []
  console.error(`  Fetched ${alerts.length} alert records.`)

  const results = detectViolations(drivers, alerts)
  console.error(`  Detected ${results.violation_count} driver(s) with violations.`)

  // 7-day rolling state
  const state = loadState()
  const todayIso = new Date().toISOString().slice(0, 10)
  updateRollingCounts(state, todayIso, new Set(results.violation_drivers))
  saveState(state)

  const summary7d = compute7DaySummary(state)

  if (cli.json) {
    console.log(JSON.stringify({
      date: todayIso,
      violations: results,
      seven_day_rolling: summary7d,
    }, null, 2))
  } else if (cli.slack) {
    // Quiet mode: only output if violations exist
    if (cli.quiet && results.violation_count === 0) return
    console.log(formatSlackMessage(results, summary7d))
  } else {
    // Human-readable
    console.log('\nHOS / ELD Compliance Watchdog Report')
    console.log('=====================================')
    console.log(`Date: ${todayIso}`)
    console.log(`Active drivers: ${results.total_drivers}`)
    console.log(`Drivers in violation: ${results.violation_count}`)
    console.log()

    if (results.violation_count === 0) {
      console.log('✅ No compliance violations detected.')
    } else {
      for (const v of results.violations) {
        console.log(`  • ${v.driver}: ${v.detail}`)
      }
    }

    console.log()
    console.log(format7DaySummary(summary7d))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})