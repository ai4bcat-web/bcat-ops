#!/usr/bin/env node
/**
 * One-off cleanup for maintenance invoices duplicated by the OLD ingest dedup.
 *
 * Background: ingest used to key on (date, equipmentId, vendor, amount, invoiceNumber).
 * Assigning a repair to a truck during review changed equipmentId, so the next run no
 * longer recognised the invoice and inserted it again. scripts/invoiceDedup.mjs fixed
 * that going forward; this script cleans up the rows already created.
 *
 * What it does: groups every invoice by the NEW document identity, and for any group
 * with more than one row, KEEPS ONE and archives the rest.
 *
 * Which one it keeps, in order of preference:
 *   1. A row a human already actioned (POSTED, then ARCHIVED) — never discard a decision.
 *   2. The row with the most information filled in (assigned truck, payment details).
 *   3. The oldest, as a stable tie-break.
 *
 * Nothing is deleted. Extras are set to status ARCHIVED, which removes them from the
 * queue and the P&L while leaving them recoverable from the Archived tab.
 *
 * Usage:
 *   node scripts/dedupeMaintenanceInvoices.mjs                 # DRY RUN (default)
 *   BCAT_EMAIL=... BCAT_PASSWORD=... node scripts/dedupeMaintenanceInvoices.mjs --apply
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'
import { legacyContentKey } from './invoiceDedup.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputs = JSON.parse(readFileSync(resolve(__dirname, '../amplify_outputs.json'), 'utf8'))
const APPSYNC_URL = outputs.data.url
Amplify.configure(outputs)

const APPLY = process.argv.includes('--apply')

const LIST = `query ListMaintenanceInvoices {
  listMaintenanceInvoices(limit: 5000) {
    items {
      id equipmentId date vendor description amount invoiceNumber
      paymentMethod paymentDate assignee source status reviewedBy externalId createdAt
    }
  }
}`

const ARCHIVE = `mutation UpdateMaintenanceInvoice($input: UpdateMaintenanceInvoiceInput!) {
  updateMaintenanceInvoice(input: $input) { id status }
}`

async function gql(query, variables, idToken) {
  const res = await fetch(APPSYNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: idToken },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}

const money = (cents) => `$${((cents ?? 0) / 100).toFixed(2)}`

/**
 * Effective review state — mirrors src/lib/invoiceStatus.ts EXACTLY, including the
 * emailed-after-cutoff rule. Dropping that rule would treat an untouched re-ingested
 * copy as POSTED and let it outrank the invoice a human actually posted.
 */
const INVOICE_QUEUE_CUTOFF = '2026-07-30T00:00:00.000Z'
const stateOf = (inv) => {
  if (inv.status === 'ARCHIVED' || inv.status === 'POSTED' || inv.status === 'PENDING') return inv.status
  if (inv.source === 'EMAIL' && (inv.createdAt ?? '') >= INVOICE_QUEUE_CUTOFF) return 'PENDING'
  return 'POSTED'
}

/** How much real information a row carries — used to keep the richest duplicate. */
function completeness(inv) {
  let score = 0
  if (inv.equipmentId && inv.equipmentId !== 'unassigned') score += 4
  if (inv.paymentMethod) score += 2
  if (inv.paymentDate) score += 2
  if (inv.description) score += 1
  if (inv.assignee) score += 1
  if (inv.reviewedBy) score += 1
  return score
}

/** Preference order for which row survives. Higher wins. */
function keepRank(inv) {
  const s = stateOf(inv)
  // A human decision outranks everything — POSTED above ARCHIVED above untouched PENDING.
  const decision = s === 'POSTED' ? 200 : s === 'ARCHIVED' ? 100 : 0
  return decision + completeness(inv)
}

function chooseKeeper(group) {
  return [...group].sort((a, b) => {
    const r = keepRank(b) - keepRank(a)
    if (r !== 0) return r
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')   // oldest wins ties
  })[0]
}

async function main() {
  let idToken = null
  if (APPLY) {
    const email = process.env.BCAT_EMAIL, password = process.env.BCAT_PASSWORD
    if (!email || !password) {
      console.error('BCAT_EMAIL and BCAT_PASSWORD are required with --apply.')
      process.exit(1)
    }
    await signIn({ username: email, password })
    idToken = (await fetchAuthSession()).tokens?.idToken?.toString() ?? null
    if (!idToken) { console.error('No ID token after sign-in'); process.exit(1) }
  } else {
    // Dry run still needs to read; reuse creds if present, otherwise explain.
    const email = process.env.BCAT_EMAIL, password = process.env.BCAT_PASSWORD
    if (!email || !password) {
      console.error('BCAT_EMAIL and BCAT_PASSWORD are required to read the invoice list.')
      process.exit(1)
    }
    await signIn({ username: email, password })
    idToken = (await fetchAuthSession()).tokens?.idToken?.toString() ?? null
  }

  const listed = await gql(LIST, {}, idToken)
  if (listed.errors) { console.error('List failed:', listed.errors[0].message); process.exit(1) }
  const all = listed.data.listMaintenanceInvoices.items ?? []

  // Group by the document identity the new ingest uses.
  const groups = new Map()
  for (const inv of all) {
    const key = inv.externalId || legacyContentKey(inv)
    const g = groups.get(key)
    if (g) g.push(inv); else groups.set(key, [inv])
  }

  const dupeGroups = [...groups.values()].filter((g) => g.length > 1)
  const toArchive = []
  for (const g of dupeGroups) {
    const keeper = chooseKeeper(g)
    for (const inv of g) {
      // Already-archived extras need no action.
      if (inv.id !== keeper.id && stateOf(inv) !== 'ARCHIVED') toArchive.push({ inv, keeper })
    }
  }

  console.log(`\nInvoices scanned:       ${all.length}`)
  console.log(`Duplicate groups:       ${dupeGroups.length}`)
  console.log(`Rows to archive:        ${toArchive.length}`)
  console.log(`Rows left untouched:    ${all.length - toArchive.length}\n`)

  for (const { inv, keeper } of toArchive.slice(0, 40)) {
    console.log(`  archive ${inv.id}  ${inv.date ?? '?'}  ${(inv.vendor ?? '?').slice(0, 28).padEnd(28)} ${money(inv.amount).padStart(10)}  [${stateOf(inv)}]`)
    console.log(`     keep ${keeper.id}  ${(keeper.equipmentId ?? '?').slice(0, 20).padEnd(20)} [${stateOf(keeper)}]`)
  }
  if (toArchive.length > 40) console.log(`  … and ${toArchive.length - 40} more`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was changed. Re-run with --apply to archive the duplicates.\n')
    return
  }

  let ok = 0, failed = 0
  for (const { inv } of toArchive) {
    const res = await gql(ARCHIVE, {
      input: { id: inv.id, status: 'ARCHIVED', reviewedBy: 'dedupe-script' },
    }, idToken)
    if (res.errors) { console.error(`  FAILED ${inv.id}: ${res.errors[0].message}`); failed++ }
    else ok++
  }
  console.log(`\nDone: ${ok} archived, ${failed} failed.\n`)
}

main().catch((err) => { console.error(err); process.exit(1) })
