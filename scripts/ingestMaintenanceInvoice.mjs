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
 * Dedup: skips if an existing invoice matches on
 *   (date, equipmentId, vendor, amount, invoiceNumber).
 * Exit codes: 0 ok, 1 fatal error, 2 zero inserted (possible dupes or parse issue).
 */

import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve, basename } from 'path'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'

const __dirname = dirname(fileURLToPath(import.meta.url))

const outputs = JSON.parse(readFileSync(resolve(__dirname, '../amplify_outputs.json'), 'utf8'))
const APPSYNC_URL = outputs.data.url
Amplify.configure(outputs)

// ─── Unit number → equipment mapping ────────────────────────────────────────
// Matches SEED_EQUIPMENT in bcat-ops/src/store/useAppStore.ts
const UNIT_TO_EQUIPMENT = {
  // Trucks
  '009':  'eq-mnmpi9jxwd12',  // Freightliner Cascadia
  '9':    'eq-mnmpi9jxwd12',
  '299':  'eq-mnevxuyoxpd8',  // Freightliner Cascadia
  '530':  'eq-mnevuhxgs5jf',  // Volvo VNL
  '685':  'eq-mnevvq8q6tcx',  // Volvo VNL
  '780':  'eq-mnevwst30vwt',  // Mack
  'TBD':  'eq-mnmpmycmsojj',  // Kenworth T680
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
function findEquipmentId(text) {
  if (!text) return null

  // Direct match against the mapping table
  const clean = String(text).trim()
  const direct = UNIT_TO_EQUIPMENT[clean]
  if (direct) return direct

  // Try stripping leading zeros for short numbers
  const stripped = clean.replace(/^0+/, '')
  if (stripped !== clean && UNIT_TO_EQUIPMENT[stripped]) {
    return UNIT_TO_EQUIPMENT[stripped]
  }

  // Fuzzy: extract any 3-6 digit number and try matching
  const numMatch = clean.match(/\b(\d{3,6})\b/)
  if (numMatch) {
    const num = numMatch[1]
    const stripped2 = num.replace(/^0+/, '')
    for (const [key, val] of Object.entries(UNIT_TO_EQUIPMENT)) {
      if (key === num || key === stripped2) return val
    }
    // Partial match: "531" in "53103"
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
function resolveEquipmentId(raw) {
  if (raw.equipmentId) return raw.equipmentId
  if (raw.unitNumber) {
    const byUnit = findEquipmentId(String(raw.unitNumber))
    if (byUnit) return byUnit
  }
  if (raw.description) return findEquipmentId(raw.description)
  return null
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const LIST_QUERY = `query ListMaintenanceInvoices {
  listMaintenanceInvoices(limit: 5000) {
    items { id date equipmentId vendor amount invoiceNumber }
  }
}`

const CREATE_MUTATION = `mutation CreateMaintenanceInvoice($input: CreateMaintenanceInvoiceInput!) {
  createMaintenanceInvoice(input: $input) {
    id equipmentId date vendor description amount invoiceNumber paymentMethod paymentDate
  }
}`

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

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Try basic regex extraction from raw email body text.
 * Returns a single invoice object (best-effort).
 * The LLM cron agent should produce better results; this is a fallback.
 */
function parseEmailBody(text) {
  const inv = {}

  // Amount: look for dollar amounts (total, amount due, etc.)
  const totalMatch = text.match(/(?:total|amount\s*due|balance\s*due|grand\s*total)\s*[:$]?\s*\$?([\d,]+\.?\d{0,2})/i)
  if (totalMatch) inv.amount = Math.round(parseFloat(totalMatch[1].replace(/,/g, '')) * 100)

  // If no total, look for any dollar amount
  if (!inv.amount) {
    const dollarMatch = text.match(/\$([\d,]+\.\d{2})/g)
    if (dollarMatch) {
      // Take the largest amount as likely the total
      const amounts = dollarMatch.map(d => parseFloat(d.replace(/[$,]/g, '')))
      inv.amount = Math.round(Math.max(...amounts) * 100)
    }
  }

  // Date: YYYY-MM-DD or MM/DD/YYYY or Month DD, YYYY
  const dateMatch = text.match(/(?:date|invoice\s*date|dated?)\s*[:]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i)
  if (dateMatch) {
    const raw = dateMatch[1]
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      inv.date = raw
    } else if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(raw)) {
      const [m, d, y] = raw.split('/')
      inv.date = `${y.length === 2 ? '20' + y : y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    }
  }

  // Invoice number
  const invNumMatch = text.match(/(?:invoice\s*#|inv\s*#|invoice\s*number|reference\s*#)\s*[:]?\s*([A-Za-z0-9\-]+)/i)
  if (invNumMatch) inv.invoiceNumber = invNumMatch[1]

  // Vendor: look for company name patterns near the top
  const vendorMatch = text.match(/(?:from|vendor|shop|dealer|billed\s*by)\s*[:]?\s*([^\n]{3,60})/i)
  if (vendorMatch) inv.vendor = vendorMatch[1].trim().replace(/[<>]/g, '')

  // Unit number
  const unitMatch = text.match(/(?:unit|truck|trailer|vehicle|equipment)\s*[#:]?\s*(\d{3,6})/i)
  if (unitMatch) {
    inv.equipmentId = findEquipmentId(unitMatch[1])
  }

  // Description: first paragraph or service description
  const descMatch = text.match(/(?:description|service|work\s*performed|repair)\s*[:]?\s*\n?\s*([^\n]{10,300})/i)
  if (descMatch) inv.description = descMatch[1].trim()

  // Payment method
  const payMatch = text.match(/(?:payment\s*method|paid\s*(?:via|by|with))\s*[:]?\s*(credit|debit|cash|check|zelle|ach|wire|card)/i)
  if (payMatch) inv.paymentMethod = payMatch[1].charAt(0).toUpperCase() + payMatch[1].slice(1).toLowerCase()

  return inv
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  let invoices = []

  // Determine input source
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
    // Only include if we got at least something useful
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
    // Read JSON from stdin
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
      // Resolve equipment the same way the write path does, so dry-run previews match.
      console.log(JSON.stringify({ ...inv, resolvedEquipmentId: resolveEquipmentId(inv) }, null, 2))
    }
    console.error('\n--dry-run: nothing written.')
    return
  }

  // Authenticate
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

  // Dedup against existing invoices
  const listed = await callAppSync(LIST_QUERY, {}, idToken)
  if (listed.errors) {
    console.error('List failed:', listed.errors[0].message)
    process.exit(1)
  }
  const existing = new Set(
    (listed.data.listMaintenanceInvoices.items ?? []).map(
      (i) => `${i.date ?? ''}|${i.equipmentId ?? ''}|${i.vendor ?? ''}|${i.amount ?? 0}|${i.invoiceNumber ?? ''}`,
    ),
  )

  let inserted = 0, duplicates = 0, failed = 0

  for (const raw of invoices) {
    // Map equipment from explicit id, unit number, or a unit ref in the description.
    const equipmentId = resolveEquipmentId(raw)

    const input = {
      ...(equipmentId && { equipmentId }),
      ...(raw.date && { date: raw.date }),
      ...(raw.vendor && { vendor: raw.vendor }),
      ...(raw.description && { description: raw.description }),
      amount: raw.amount || 0,  // cents, required
      ...(raw.invoiceNumber && { invoiceNumber: raw.invoiceNumber }),
      ...(raw.paymentMethod && { paymentMethod: raw.paymentMethod }),
      ...(raw.paymentDate && { paymentDate: raw.paymentDate }),
      ...(raw.assignee && { assignee: raw.assignee }),
    }

    // Skip if nothing useful
    if (!input.vendor && !input.amount) {
      console.error(`  SKIP: no vendor or amount: ${JSON.stringify(raw)}`)
      failed++
      continue
    }

    // Dedup check
    const dedupKey = `${input.date ?? ''}|${input.equipmentId ?? ''}|${input.vendor ?? ''}|${input.amount ?? 0}|${input.invoiceNumber ?? ''}`
    if (existing.has(dedupKey)) {
      console.error(`  DUPLICATE: ${dedupKey}`)
      duplicates++
      continue
    }

    const result = await callAppSync(CREATE_MUTATION, { input }, idToken)
    if (result.errors) {
      console.error(`  FAIL: ${result.errors[0].message} — ${JSON.stringify(input)}`)
      failed++
    } else {
      existing.add(dedupKey)
      inserted++
      const created = result.data.createMaintenanceInvoice
      console.error(`  OK: ${created.id} vendor=${input.vendor} amount=${input.amount} equipment=${input.equipmentId || 'unassigned'}`)
    }
  }

  console.error(`\nDone: ${inserted} inserted, ${duplicates} duplicates skipped, ${failed} failed.`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
