#!/usr/bin/env node
/**
 * One-off cleanup for maintenance invoices duplicated by the OLD ingest dedup.
 *
 * Background: ingest used to key on (date, equipmentId | vendor | amount | invoiceNumber).
 * Assigning a repair to a truck during review changed equipmentId, so the next run no
 * longer recognised the invoice and inserted it again. scripts/invoiceDedup.mjs fixed
 * that going forward; this script cleans up the rows already created.
 *
 * What it does: groups every invoice by the NEW document identity, including legacy rows
 * that predate externalId, and for any group with more than one row, KEEPS ONE and
 * archives the rest.
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
 *   node scripts/dedupeMaintenanceInvoices.mjs --apply         # actually archive
 *
 * Credentials come from BCAT_EMAIL / BCAT_PASSWORD if set; otherwise the script asks
 * for them. Prompting is the recommended path — passing a password on the command line
 * puts it in your shell history, and any quote or $ in it breaks the shell quoting.
 */
import { readFileSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, resolve } from 'path'
import { createInterface } from 'node:readline'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'
import { legacyContentKey, normalizeInvoiceNumber } from './invoiceDedup.mjs'

const APPLY = process.argv.includes('--apply')

const INVOICE_FIELDS = [
  'id', 'equipmentId', 'date', 'vendor', 'description', 'amount', 'invoiceNumber',
  'paymentMethod', 'paymentDate', 'assignee', 'source', 'status', 'reviewedBy',
  'externalId', 'createdAt',
].join(' ')

const LIST = `query ListMaintenanceInvoices($nextToken: String) {
  listMaintenanceInvoices(nextToken: $nextToken, limit: 1000) {
    items { ${INVOICE_FIELDS} }
    nextToken
  }
}`

const ARCHIVE = `mutation UpdateMaintenanceInvoice($input: UpdateMaintenanceInvoiceInput!) {
  updateMaintenanceInvoice(input: $input) { id status }
}`

const money = (cents) => `$${((cents ?? 0) / 100).toFixed(2)}`

/**
 * Effective review state — mirrors src/lib/invoiceStatus.ts EXACTLY, including the
 * emailed-after-cutoff rule. Dropping that rule would treat an untouched re-ingested
 * copy as POSTED and let it outrank the invoice a human actually posted.
 */
export const INVOICE_QUEUE_CUTOFF = '2026-07-30T00:00:00.000Z'
export function stateOf(inv) {
  if (inv.status === 'ARCHIVED' || inv.status === 'POSTED' || inv.status === 'PENDING') return inv.status
  if (inv.source === 'EMAIL' && (inv.createdAt ?? '') >= INVOICE_QUEUE_CUTOFF) return 'PENDING'
  return 'POSTED'
}

/** How much real information a row carries — used to keep the richest duplicate. */
export function completeness(inv) {
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
export function keepRank(inv) {
  const s = stateOf(inv)
  // A human decision outranks everything — POSTED above ARCHIVED above untouched PENDING.
  const decision = s === 'POSTED' ? 200 : s === 'ARCHIVED' ? 100 : 0
  return decision + completeness(inv)
}

export function chooseKeeper(group) {
  return [...group].sort((a, b) => {
    const r = keepRank(b) - keepRank(a)
    if (r !== 0) return r
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')   // oldest wins ties
  })[0]
}

function contentKey(inv) {
  return legacyContentKey(inv)
}

function nonUnassignedEquipmentIds(group) {
  const ids = new Set()
  for (const inv of group ?? []) {
    if (inv.equipmentId && inv.equipmentId !== 'unassigned') ids.add(inv.equipmentId)
  }
  return [...ids]
}

/**
 * Split duplicate groups into safe auto-archive rows and rows that need human review.
 *
 * Any duplicate group whose members are assigned to more than one real truck is treated as
 * a candidate per-unit split expense. That covers unnumbered emailed entries, numbered
 * manual splits, and even shared-externalId groups whose content-derived IDs historically
 * collided. Only groups with one distinct assigned truck (or no real assignments) are
 * auto-archived.
 */
export function partitionArchiveCandidates(groups) {
  const safeToArchive = []
  const reviewNeeded = []
  const groupEntries = Array.isArray(groups) ? groups : [...groups.values()]
  for (const group of groupEntries) {
    if (!group || group.length <= 1) continue
    const keeper = chooseKeeper(group)
    const assignedIds = nonUnassignedEquipmentIds(group)
    if (assignedIds.length > 1) {
      reviewNeeded.push({ group, keeper, assignedEquipmentIds: assignedIds })
      continue
    }
    for (const inv of group) {
      if (inv.id !== keeper.id && stateOf(inv) !== 'ARCHIVED') {
        safeToArchive.push({ inv, keeper })
      }
    }
  }
  return { safeToArchive, reviewNeeded }
}

/**
 * Group invoices that represent the same source document.
 *
 * An invoice may be linked to others by its immutable externalId (new ingest) or by its
 * normalized content key (legacy rows). Because two invoices can share a content key
 * while only one of them carries an externalId, simple one-key grouping would keep the
 * legacy and modern copies apart. This function builds the transitive closure so that any
 * chain of externalId-or-content links collapses into one group.
 *
 * Identity semantics are intentionally narrow: distinct source documents with distinct
 * dates, vendors, amounts, or invoice numbers never share a group.
 */
export function groupInvoicesByIdentity(invoices) {
  const parent = new Map()
  const rank = new Map()

  function find(x) {
    if (!parent.has(x)) {
      parent.set(x, x)
      rank.set(x, 0)
      return x
    }
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)
    // path compression
    let curr = x
    while (parent.get(curr) !== root) {
      const next = parent.get(curr)
      parent.set(curr, root)
      curr = next
    }
    return root
  }

  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    const raRank = rank.get(ra)
    const rbRank = rank.get(rb)
    if (raRank < rbRank) {
      parent.set(ra, rb)
    } else if (raRank > rbRank) {
      parent.set(rb, ra)
    } else {
      parent.set(rb, ra)
      rank.set(ra, raRank + 1)
    }
  }

  // Content grouping is only safe for numbered invoices. Unnumbered manual or emailed
  // entries with the same date/vendor/amount can be legitimate repeat expenses across
  // different trucks, so we never collapse them based on content alone. Shared externalId
  // still links exact source documents.
  const canGroupByContent = (inv) => normalizeInvoiceNumber(inv.invoiceNumber).length > 0

  const byExternalId = new Map()
  const byContent = new Map()

  for (const inv of invoices ?? []) {
    const id = inv.id
    if (!id) continue

    if (inv.externalId) {
      if (byExternalId.has(inv.externalId)) union(id, byExternalId.get(inv.externalId))
      else byExternalId.set(inv.externalId, id)
    }

    if (!canGroupByContent(inv)) continue
    const ck = contentKey(inv)
    if (byContent.has(ck)) union(id, byContent.get(ck))
    else byContent.set(ck, id)
  }

  const groups = new Map()
  for (const inv of invoices ?? []) {
    if (!inv.id) continue
    const root = find(inv.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(inv)
  }
  return groups
}

/** Ask a question on the terminal; `hidden` suppresses echo for passwords. */
function ask(question, { hidden = false } = {}) {
  return new Promise((resolvePrompt, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(
        'No terminal available to prompt for credentials.\n' +
        'Run this in a normal terminal, or set BCAT_EMAIL and BCAT_PASSWORD first.',
      ))
      return
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      // Swallow the echoed characters so the password never appears on screen.
      rl._writeToOutput = (str) => { if (str.includes(question)) rl.output.write(question) }
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolvePrompt(answer.trim()) })
  })
}

async function gql(query, variables, idToken, appSyncUrl) {
  const res = await fetch(appSyncUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: idToken },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}

async function fetchAllInvoices(idToken, appSyncUrl) {
  const all = []
  let nextToken = null
  do {
    const page = await gql(LIST, { nextToken }, idToken, appSyncUrl)
    if (page.errors) throw new Error(page.errors[0].message)
    const list = page.data?.listMaintenanceInvoices
    if (!list) throw new Error('listMaintenanceInvoices payload missing')
    all.push(...(list.items ?? []).filter(Boolean))
    nextToken = list.nextToken
  } while (nextToken)
  return all
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const outputs = JSON.parse(readFileSync(resolve(__dirname, '../amplify_outputs.json'), 'utf8'))
  const appSyncUrl = outputs.data.url
  Amplify.configure(outputs)

  const email = process.env.BCAT_EMAIL || await ask('ops.bcatcorp.com email: ')
  const password = process.env.BCAT_PASSWORD || await ask('password (hidden): ', { hidden: true })
  if (!email || !password) { console.error('Email and password are required.'); process.exit(1) }

  try {
    await signIn({ username: email, password })
  } catch (err) {
    console.error(`\nSign-in failed: ${err?.message ?? err}`)
    process.exit(1)
  }
  const idToken = (await fetchAuthSession()).tokens?.idToken?.toString() ?? null
  if (!idToken) { console.error('No ID token after sign-in'); process.exit(1) }
  console.log(`\nSigned in as ${email}${APPLY ? '' : '  ·  DRY RUN'}`)

  const all = await fetchAllInvoices(idToken, appSyncUrl)
  const groups = groupInvoicesByIdentity(all)
  const dupeGroups = [...groups.values()].filter((g) => g.length > 1)
  const { safeToArchive, reviewNeeded } = partitionArchiveCandidates(dupeGroups)

  console.log(`\nInvoices scanned:       ${all.length}`)
  console.log(`Duplicate groups:       ${dupeGroups.length}`)
  console.log(`Review-needed groups:   ${reviewNeeded.length}`)
  console.log(`Rows to archive:        ${safeToArchive.length}`)
  console.log(`Rows left untouched:    ${all.length - safeToArchive.length}\n`)

  if (reviewNeeded.length) {
    console.log('AMBIGUOUS — needs manual review before any archive:')
    for (const { group, keeper, assignedEquipmentIds } of reviewNeeded.slice(0, 20)) {
      console.log(`\n  group with conflicting equipment [${assignedEquipmentIds.join(', ')}], keeper chosen: ${keeper.id}`)
      for (const inv of group) {
        console.log(`    ${inv.id}  ${inv.date ?? '?'}  ${(inv.vendor ?? '?').slice(0, 28).padEnd(28)} ${money(inv.amount).padStart(10)}  eq:${(inv.equipmentId ?? '?').padStart(12)}  desc:${(inv.description ?? '-').slice(0, 24).padEnd(24)}  [${stateOf(inv)}]`)
      }
    }
    if (reviewNeeded.length > 20) console.log(`  … and ${reviewNeeded.length - 20} more review groups`)
    console.log()
  }

  for (const { inv, keeper } of safeToArchive.slice(0, 40)) {
    console.log(`  archive ${inv.id}  ${inv.date ?? '?'}  ${(inv.vendor ?? '?').slice(0, 28).padEnd(28)} ${money(inv.amount).padStart(10)}  eq:${(inv.equipmentId ?? '?').padStart(12)}  desc:${(inv.description ?? '-').slice(0, 24).padEnd(24)}  [${stateOf(inv)}]`)
    console.log(`     keep ${keeper.id}  ${(keeper.date ?? '?').padEnd(10)}  eq:${(keeper.equipmentId ?? '?').padStart(12)}  desc:${(keeper.description ?? '-').slice(0, 24).padEnd(24)}  [${stateOf(keeper)}]`)
  }
  if (safeToArchive.length > 40) console.log(`  … and ${safeToArchive.length - 40} more`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was changed. Re-run with --apply to archive the duplicates.\n')
    return
  }

  let ok = 0
  let failed = 0
  for (const { inv } of safeToArchive) {
    const res = await gql(ARCHIVE, {
      input: { id: inv.id, status: 'ARCHIVED', reviewedBy: 'dedupe-script' },
    }, idToken, appSyncUrl)
    if (res.errors) { console.error(`  FAILED ${inv.id}: ${res.errors[0].message}`); failed++ }
    else ok++
  }
  console.log(`\nDone: ${ok} archived, ${failed} failed.\n`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
