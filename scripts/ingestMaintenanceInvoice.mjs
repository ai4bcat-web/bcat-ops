#!/usr/bin/env node
/**
 * Ingest maintenance invoices (structured JSON) into the bcat-ops AppSync backend.
 * Built for the daily maintenance-invoice email job.
 *
 * Input: JSON array of invoice objects on stdin, or --json '<array>', or --email-body <file>
 *
 * Usage:
 *   echo '[{...}]' | BCAT_EMAIL=... BCAT_PASSWORD=... node scripts/ingestMaintenanceInvoice.mjs
 *   node scripts/ingestMaintenanceInvoice.mjs --json '[{...}]' [--dry-run]
 *   node scripts/ingestMaintenanceInvoice.mjs --email-body /tmp/invoice.txt [--dry-run]
 *
 * Dedup: each invoice gets a stable `externalId` derived from what the source document
 * says (date, vendor, amount, invoice #; sourceDocumentId for unnumbered documents) —
 * NOT the equipmentId assigned during review. Source identifiers must remain stable
 * across retries. See scripts/invoiceDedup.mjs.
 *
 * To prevent concurrent ingests from inserting the same email twice, every create uses a
 * deterministic id derived from externalId. A conditional conflict is treated as a
 * duplicate only after get-by-id confirms the existing invoice carries the same immutable
 * externalId; any other error or externalId mismatch is reported and fails the run.
 *
 * Exit codes: 0 ok, 1 fatal error or any insert failure (no silent loss).
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve, basename } from 'node:path'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'
import {
  invoiceExternalId,
  legacyContentKey,
  buildSeenIndex,
  classifyDedup,
  dedupIsDuplicate,
  dedupIsAmbiguous,
} from './invoiceDedup.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const outputs = JSON.parse(readFileSync(resolve(__dirname, '../amplify_outputs.json'), 'utf8'))
const APPSYNC_URL = outputs.data.url
Amplify.configure(outputs)

const DEFAULT_PAGE_LIMIT = 5000
const EMAIL_SOURCE = 'EMAIL'
const PENDING_STATUS = 'PENDING'
const ID_PREFIX = 'inv-email'

// ─── Unit number → equipment mapping ──────────────────────────────────────────
// Matches SEED_EQUIPMENT in bcat-ops/src/store/useAppStore.ts
const UNIT_TO_EQUIPMENT = {
  // Trucks
  '009':   'eq-mnmpi9jxwd12',   // Freightliner Cascadia
  '9':     'eq-mnmpi9jxwd12',
  '299':   'eq-mnevxuyoxpd8',   // Freightliner Cascadia
  '530':   'eq-mnevuhxgs5jf',   // Volvo VNL
  '685':   'eq-mnevvq8q6tcx',   // Volvo VNL
  '780':   'eq-mnevwst30vwt',   // Mack
  '89510': 'equip-1781464883907', // Volvo VNL 740 (2017)
  'TBD':   'eq-mnmpmycmsojj',   // Kenworth T680
  // Trailers
  '53103':  'eq-mnex02osubxo',  // Utility
  '53105':  'eq-mnewzfg20sho',  // Utility
  '531375': 'eq-mnew9mqmquur',  // Hyundai
  '531386': 'eq-mnewh0pwm7vt',  // Great Dane
  '531388': 'eq-mnewi3v8937x',  // Great Dane
  '531389': 'eq-mnewsbtqzn4b',  // Great Dane
  '531394': 'eq-mnewjegoteii',  // Great Dane
  '5384':   'eq-mnewwmcsjary',  // Great Dane
  '5389':   'eq-mnewyfmrxltl',  // Great Dane
  '5922':   'eq-mnewvn8cag19',  // Great Dane
}

/**
 * Try to match a unit reference from text to an equipment ID.
 * Handles: "Unit 530", "truck 530", "#530", "530", "Volvo 530", "Trailer 53103"
 */
export function findEquipmentId(text) {
  if (!text) return null

  const clean = String(text).trim()
  const direct = UNIT_TO_EQUIPMENT[clean]
  if (direct) return direct

  const stripped = clean.replace(/^0+/, '')
  if (stripped !== clean && UNIT_TO_EQUIPMENT[stripped]) {
    return UNIT_TO_EQUIPMENT[stripped]
  }

  const numMatch = clean.match(/\b(\d{3,6})\b/)
  if (numMatch) {
    const num = numMatch[1]
    const stripped2 = num.replace(/^0+/, '')
    for (const [key, val] of Object.entries(UNIT_TO_EQUIPMENT)) {
      if (key === num || key === stripped2) return val
    }
    for (const [key, val] of Object.entries(UNIT_TO_EQUIPMENT)) {
      if (key.includes(num) || num.includes(key)) return val
    }
  }

  return null
}

/**
 * Resolve an invoice's equipment ID: explicit id wins, then unitNumber, then
 * a unit reference embedded in the description. Used by both dry-run and writes.
 */
export function resolveEquipmentId(raw) {
  if (raw.equipmentId) return raw.equipmentId
  if (raw.unitNumber) {
    const byUnit = findEquipmentId(String(raw.unitNumber))
    if (byUnit) return byUnit
  }
  if (raw.description) return findEquipmentId(raw.description)
  return null
}

/**
 * Deterministic record id for an invoice. Derived from its immutable externalId so
 * concurrent ingests race on the same DynamoDB key instead of creating two rows.
 */
export function deriveInvoiceId(externalId) {
  return `${ID_PREFIX}-${externalId}`
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const LIST_INVOICES_QUERY = `query ListMaintenanceInvoices($nextToken: String, $limit: Int) {
  listMaintenanceInvoices(nextToken: $nextToken, limit: $limit) {
    items { id date equipmentId vendor amount invoiceNumber status externalId source }
    nextToken
  }
}`

const GET_INVOICE_QUERY = `query GetMaintenanceInvoice($id: ID!) {
  getMaintenanceInvoice(id: $id) { id externalId }
}`

const CREATE_MUTATION = `mutation CreateMaintenanceInvoice($input: CreateMaintenanceInvoiceInput!) {
  createMaintenanceInvoice(input: $input) {
    id equipmentId date vendor description amount invoiceNumber paymentMethod paymentDate source externalId
  }
}`

/** Default AppSync transport. Replace at the function boundary for tests. */
async function callAppSync(query, variables, idToken) {
  const res = await fetch(APPSYNC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: idToken,
    },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}

/**
 * Page through every MaintenanceInvoice in the backend, following nextToken even
 * through empty pages. An error at any page fails closed.
 */
export async function listAllInvoices(callAppSync, idToken, limit = DEFAULT_PAGE_LIMIT) {
  const items = []
  let nextToken = null
  do {
    const raw = await callAppSync(LIST_INVOICES_QUERY, { limit, nextToken }, idToken)
    if (raw.errors) {
      throw new Error(raw.errors.map((e) => e.message ?? JSON.stringify(e)).join('; '))
    }
    const page = raw.data?.listMaintenanceInvoices
    if (typeof page !== 'object' || page === null) {
      throw new Error('listMaintenanceInvoices returned malformed response (missing connection)')
    }
    const pageItems = Array.isArray(page.items) ? page.items.filter((item) => item != null) : []
    items.push(...pageItems)
    nextToken = page.nextToken ?? null
  } while (nextToken)
  return items
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Try basic regex extraction from raw email body text.
 * Returns a single invoice object (best-effort).
 * The LLM cron agent should produce better results; this is a fallback.
 */
export function parseEmailBody(text) {
  const inv = {}

  // Amount: look for dollar amounts (total, amount due, etc.)
  const totalMatch = text.match(/(?:total|amount\s*due|balance\s*due|grand\s*total)\s*[:$]?\s*\$?([\d,]+\.?\d{0,2})/i)
  if (totalMatch) inv.amount = Math.round(parseFloat(totalMatch[1].replace(/,/g, '')) * 100)

  // If no total, look for any dollar amount
  if (!inv.amount) {
    const dollarMatch = text.match(/\$([\d,]+\.\d{2})/g)
    if (dollarMatch) {
      const amounts = dollarMatch.map((d) => parseFloat(d.replace(/[$,]/g, '')))
      inv.amount = Math.round(Math.max(...amounts) * 100)
    }
  }

  // Date: YYYY-MM-DD or MM/DD/YYYY or Month DD, YYYY
  const dateMatch = text.match(/(?:date|invoice\s*date|dated?)\s*[:]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i)
  if (dateMatch) {
    const rawDate = dateMatch[1]
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      inv.date = rawDate
    } else if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(rawDate)) {
      const [m, d, y] = rawDate.split('/')
      inv.date = `${y.length === 2 ? '20' + y : y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    }
  }

  // Invoice number
  const invNumMatch = text.match(/(?:invoice\s*#|inv\s*#|invoice\s*number|reference\s*#)\s*[:]?\s*([A-Za-z0-9\-]+)/i)
  if (invNumMatch) inv.invoiceNumber = invNumMatch[1]

  // Vendor: look for company name patterns near the top
  const vendorMatch = text.match(/(?:from|vendor|shop|dealer|billed\s*by)\s*[:]?(\s*[^\n]{3,60})/i)
  if (vendorMatch) inv.vendor = vendorMatch[1].trim().replace(/[<>]/g, '')

  // Unit number
  const unitMatch = text.match(/(?:unit|truck|trailer|vehicle|equipment)\s*[#:]?\s*(\d{3,6})/i)
  if (unitMatch) {
    inv.equipmentId = findEquipmentId(unitMatch[1])
  }

  // Description: first paragraph or service description
  const descMatch = text.match(/(?:description|service|work\s*performed|repair)\s*[:]?(\s*\n?\s*[^\n]{10,300})/i)
  if (descMatch) inv.description = descMatch[1].trim().replace(/^\s+/, '')

  // Payment method
  const payMatch = text.match(/(?:payment\s*method|paid\s*(?:via|by|with))\s*[:]?(\s*(credit|debit|cash|check|zelle|ach|wire|card))/i)
  if (payMatch) inv.paymentMethod = payMatch[2].charAt(0).toUpperCase() + payMatch[2].slice(1).toLowerCase()

  return inv
}

// ─── Write path ───────────────────────────────────────────────────────────────

/**
 * Ingest an array of parsed invoices. Authentication and transport are injected via
 * callAppSync so tests can mock the backend without touching real data.
 *
 * Returns { inserted, duplicates, failed }.
 */
export async function processInvoices(invoices, { idToken, callAppSync }) {
  if (!idToken) throw new Error('idToken required')
  if (typeof callAppSync !== 'function') throw new Error('callAppSync transport required')

  const allExisting = await listAllInvoices(callAppSync, idToken)
  const seen = buildSeenIndex(allExisting)

  let inserted = 0
  let duplicates = 0
  let failed = 0

  for (const raw of invoices) {
    const equipmentId = resolveEquipmentId(raw) || 'unassigned'
    const externalId = invoiceExternalId(raw)
    const id = deriveInvoiceId(externalId)

    const input = {
      equipmentId,
      ...(raw.date && { date: raw.date }),
      ...(raw.vendor && { vendor: raw.vendor }),
      ...(raw.description && { description: raw.description }),
      amount: raw.amount ?? 0,
      ...(raw.invoiceNumber && { invoiceNumber: raw.invoiceNumber }),
      ...(raw.paymentMethod && { paymentMethod: raw.paymentMethod }),
      ...(raw.paymentDate && { paymentDate: raw.paymentDate }),
      ...(raw.assignee && { assignee: raw.assignee }),
      source: EMAIL_SOURCE,
      status: PENDING_STATUS,
    }

    if (!input.vendor && !input.amount) {
      console.error(`  SKIP: no vendor or amount: ${JSON.stringify(raw)}`)
      failed++
      continue
    }

    const dedup = classifyDedup(raw, seen)
    if (dedupIsDuplicate(dedup)) {
      console.error(`  DUPLICATE (already ingested): ${input.vendor ?? '?'} ${input.invoiceNumber ?? ''} ${input.amount ?? 0}`)
      duplicates++
      continue
    }
    if (dedupIsAmbiguous(dedup)) {
      console.error(`  AMBIGUOUS (needs manual review): ${input.vendor ?? '?'} ${input.invoiceNumber ?? ''} ${input.amount ?? 0} sourceDocumentId=${raw.sourceDocumentId ?? 'none'}`)
      failed++
      continue
    }

    const result = await callAppSync(
      CREATE_MUTATION,
      { input: { ...input, id, externalId } },
      idToken,
    )

    if (result.errors) {
      const isConflict = result.errors.some(
        (e) =>
          e.errorType === 'ConditionalCheckFailedException' ||
          e.errorType === 'DynamoDB:ConditionalCheckFailedException',
      )

      if (isConflict) {
        const got = await callAppSync(GET_INVOICE_QUERY, { id }, idToken)
        if (got.errors) {
          console.error(`  FAIL: duplicate id but get-by-id failed — ${got.errors.map((e) => e.message).join('; ')}`)
          failed++
          continue
        }
        const existing = got.data?.getMaintenanceInvoice
        if (existing?.externalId === externalId) {
          console.error(`  DUPLICATE (concurrent): ${input.vendor ?? '?'} ${input.invoiceNumber ?? ''} ${input.amount ?? 0}`)
          duplicates++
          continue
        }
        console.error(
          `  FAIL: duplicate id did not match expected externalId — id=${id} expectedExternalId=${externalId} existing=${JSON.stringify(existing)}`,
        )
        failed++
        continue
      }

      console.error(`  FAIL: ${result.errors[0].message} — ${JSON.stringify(input)}`)
      failed++
      continue
    }

    const created = result.data?.createMaintenanceInvoice
    if (created?.id !== id || created?.externalId !== externalId) {
      console.error(`  FAIL: create returned mismatched or missing id/externalId — expected id=${id} externalId=${externalId} got=${JSON.stringify(created)}`)
      failed++
      continue
    }

    seen.byExternalId.add(externalId)
    if (String(raw?.sourceDocumentId ?? '') === '') {
      seen.byClassicExternalId.add(externalId)
    }
    seen.byContent.add(legacyContentKey(raw))
    inserted++
    console.error(`  OK: ${created.id} vendor=${input.vendor} amount=${input.amount} equipment=${input.equipmentId || 'unassigned'}`)
  }

  return { inserted, duplicates, failed }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  let invoices = []

  const emailBodyPath = args.includes('--email-body')
    ? args[args.indexOf('--email-body') + 1]
    : null
  const jsonArg = args.includes('--json')
    ? args[args.indexOf('--json') + 1]
    : null

  if (emailBodyPath) {
    if (!existsSync(emailBodyPath)) {
      console.error(`File not found: ${emailBodyPath}`)
      process.exit(1)
    }
    const text = readFileSync(emailBodyPath, 'utf8')
    console.error(`Parsing email body: ${basename(emailBodyPath)} (${text.length} chars)`)
    const parsed = parseEmailBody(text)
    if (parsed.vendor || parsed.amount) {
      invoices.push(parsed)
    } else {
      console.error('Could not extract invoice data from email body. First 300 chars:')
      console.error(text.slice(0, 300))
      process.exit(2)
    }
  } else if (jsonArg) {
    try {
      const parsed = JSON.parse(jsonArg)
      invoices = Array.isArray(parsed) ? parsed : [parsed]
    } catch (e) {
      console.error('Invalid JSON input:', e.message)
      process.exit(1)
    }
  } else {
    let stdin = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      stdin += chunk
    }
    if (stdin.trim()) {
      try {
        const parsed = JSON.parse(stdin)
        invoices = Array.isArray(parsed) ? parsed : [parsed]
      } catch (e) {
        console.error('Invalid JSON on stdin:', e.message)
        process.exit(1)
      }
    } else {
      console.error('No input provided. Usage: script --json <data> | --email-body <file> | stdin JSON')
      console.error('Expected JSON shape: [{"date":"2026-06-10","vendor":"...","amount":12345,...}]')
      process.exit(1)
    }
  }

  if (invoices.length === 0) {
    console.error('No invoices to process.')
    process.exit(2)
  }

  console.error(`Processing ${invoices.length} invoice(s)...`)

  if (dryRun) {
    for (const inv of invoices) {
      console.log(JSON.stringify({ ...inv, resolvedEquipmentId: resolveEquipmentId(inv) }))
    }
    console.error('\n--dry-run: nothing written.')
    return
  }

  const email = process.env.BCAT_EMAIL
  const password = process.env.BCAT_PASSWORD
  if (!email || !password) {
    console.error('BCAT_EMAIL and BCAT_PASSWORD env vars required for writes (or use --dry-run).')
    process.exit(1)
  }

  await signIn({ username: email, password })
  const session = await fetchAuthSession()
  const idToken = session.tokens?.idToken?.toString()
  if (!idToken) {
    console.error('No ID token after sign-in')
    process.exit(1)
  }

  const { inserted, duplicates, failed } = await processInvoices(invoices, { idToken, callAppSync })

  console.error(`\nDone: ${inserted} inserted, ${duplicates} duplicates skipped, ${failed} failed.`)
  if (failed > 0) process.exit(1)
}

if (process.argv.length > 1 && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
