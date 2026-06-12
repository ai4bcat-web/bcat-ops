#!/usr/bin/env node
/**
 * Ingest an EFS fuel report (text or PDF) into the bcat-ops AppSync backend.
 * Built for the daily fuel-report email job (Command Center iv1).
 *
 * Usage:
 *   BCAT_EMAIL=you@example.com BCAT_PASSWORD=... node scripts/ingestFuelReport.mjs <report.txt|report.pdf> [--dry-run]
 *
 * - PDF input requires `pdftotext -layout` (poppler) on PATH.
 * - Dedup: a transaction is skipped if an existing row matches on
 *   (transactionDate, cardNumber, invoiceNumber, fuelType, amount).
 * - sourceFile is set to the input filename so imports are traceable.
 * - Exit codes: 0 ok, 1 fatal error, 2 parsed zero transactions (likely format change).
 */
import { readFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, resolve, basename } from 'path'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'

const __dirname = dirname(fileURLToPath(import.meta.url))

const outputs = JSON.parse(readFileSync(resolve(__dirname, '../amplify_outputs.json'), 'utf8'))
const APPSYNC_URL = outputs.data.url
Amplify.configure(outputs)

// ─── Card → truck mapping (matches useAppStore / seedFuelData) ────────────────
const CARD_TO_TRUCK = {
  '00049': 'eq-mnmpi9jxwd12',  // Unit 009
  '00056': 'eq-mnevxuyoxpd8',  // Unit 299
  '00031': 'eq-mnevuhxgs5jf',  // Unit 530
  '00007': 'eq-mnevvq8q6tcx',  // Unit 685
  '00023': 'eq-mnevwst30vwt',  // Unit 780
}

// ─── Parser (same logic as src/lib/parsers/efsTransactionReport.ts) ───────────
// Kept in sync manually; if the app parser changes, update here too.
// Handles both the URL-download text format ("USD/Gallon", indented card #)
// and the PDF -> pdftotext -layout format ("USD/Gallons", card # at col 0).
const FUEL_ITEM_TYPES = new Set(['ULSD', 'FUEL', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])
const TX_LINE_RE = /[A-Z]\s{1,4}USD\/Gallons?\s*$/
const RIGHT_RE = /(\S+)\s+(?:([\d,]+\.?\d*)\s+)?([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([A-Z])\s+USD\/Gallons?/
const CARD_RE = /^\s{0,8}(\d{5})\s/
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b|\b(\d{1,2}\/\d{1,2}\/\d{4})\b/

const num = (s) => parseFloat(String(s ?? '0').replace(/,/g, ''))

function toIsoDate(raw) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const [m, d, y] = raw.split('/')
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function categorize(itemType) {
  const u = itemType.toUpperCase().trim()
  if (FUEL_ITEM_TYPES.has(u)) return 'FUEL'
  if (u === 'SCLE') return 'SCALE'
  if (u === 'CASH') return 'CASH_ADVANCE'
  return 'OTHER'
}

function parseReport(text) {
  const lines = text.split('\n')
  const transactions = []
  let prev = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!TX_LINE_RE.test(line)) continue
    const right = RIGHT_RE.exec(line)
    if (!right) continue

    const [, itemType, rawPrice, rawQty, rawAmount] = right
    const cardMatch = CARD_RE.exec(line)
    const dateMatch = DATE_RE.exec(line)
    const isPrimary = !!cardMatch && !!dateMatch

    let header
    if (isPrimary) {
      const leftPart = line.substring(0, line.search(RIGHT_RE)).trimEnd()
      const tokens = leftPart.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)
      // tokens: [card, date, invoice, unit, (driver), (odometer), location, city, state]
      let idx = 4
      let driverName = ''
      let odometer = null
      if (tokens[idx] && /^\d+$/.test(tokens[idx])) {
        odometer = parseInt(tokens[idx], 10); idx++
      } else if (tokens[idx]) {
        driverName = tokens[idx]; idx++
        if (tokens[idx] && /^\d+$/.test(tokens[idx])) { odometer = parseInt(tokens[idx], 10); idx++ }
      }
      header = {
        cardNumber: cardMatch[1],
        transactionDate: toIsoDate(dateMatch[1] ?? dateMatch[2]),
        invoiceNumber: tokens[2] ?? '',
        unitNumber: tokens[3] ?? '',
        driverName,
        odometer,
        locationName: tokens[idx] ?? '',
        city: tokens[idx + 1] ?? '',
        state: tokens[idx + 2] ?? '',
      }
      prev = header
    } else {
      if (!prev) continue // continuation before any primary line — malformed
      header = { ...prev, odometer: null }
    }

    transactions.push({
      ...header,
      fees: 0,
      fuelType: itemType.toUpperCase().trim(),
      itemCategory: categorize(itemType),
      pricePerUnit: rawPrice ? num(rawPrice) : 0,
      quantity: num(rawQty),
      amount: num(rawAmount),
      currency: 'USD',
      sourceLineNumber: i + 1,
    })
  }
  return transactions
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────
const LIST_QUERY = `query ListFuelTransactions {
  listFuelTransactions(limit: 10000) {
    items { id transactionDate cardNumber invoiceNumber fuelType amount }
  }
}`
const CREATE_MUTATION = `mutation CreateFuelTransaction($input: CreateFuelTransactionInput!) {
  createFuelTransaction(input: $input) { id transactionDate cardNumber fuelType amount }
}`

async function callAppSync(query, variables, idToken) {
  const res = await fetch(APPSYNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: idToken },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const filePath = args.find((a) => !a.startsWith('--'))

  if (!filePath || !existsSync(filePath)) {
    console.error('Usage: node scripts/ingestFuelReport.mjs <report.txt|report.pdf> [--dry-run]')
    process.exit(1)
  }

  // PDF → text via pdftotext -layout (preserves fixed-width columns).
  let text
  if (filePath.toLowerCase().endsWith('.pdf')) {
    try {
      text = execFileSync('pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8' })
    } catch (e) {
      console.error('pdftotext failed (install poppler: brew install poppler):', e.message)
      process.exit(1)
    }
  } else {
    text = readFileSync(filePath, 'utf8')
  }

  const parsed = parseReport(text)
  console.log(`Parsed ${parsed.length} transactions from ${basename(filePath)}`)
  if (parsed.length === 0) {
    console.error('Zero transactions parsed — report format may have changed. First 500 chars:')
    console.error(text.slice(0, 500))
    process.exit(2)
  }

  if (dryRun) {
    for (const t of parsed) {
      console.log(`  ${t.transactionDate} card=${t.cardNumber} inv=${t.invoiceNumber} ${t.fuelType} qty=${t.quantity} $${t.amount}`)
    }
    console.log('\n--dry-run: nothing written.')
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
  if (!idToken) { console.error('No ID token after sign-in'); process.exit(1) }

  // Dedup against existing rows.
  const listed = await callAppSync(LIST_QUERY, {}, idToken)
  if (listed.errors) { console.error('List failed:', listed.errors[0].message); process.exit(1) }
  const existing = new Set(
    (listed.data.listFuelTransactions.items ?? []).map(
      (t) => `${t.transactionDate}|${t.cardNumber}|${t.invoiceNumber ?? ''}|${t.fuelType}|${t.amount}`,
    ),
  )

  let inserted = 0, duplicates = 0, failed = 0
  for (const tx of parsed) {
    const key = `${tx.transactionDate}|${tx.cardNumber}|${tx.invoiceNumber}|${tx.fuelType}|${tx.amount}`
    if (existing.has(key)) { duplicates++; continue }

    const input = {
      transactionDate: tx.transactionDate,
      cardNumber: tx.cardNumber,
      ...(tx.invoiceNumber && { invoiceNumber: tx.invoiceNumber }),
      ...(tx.unitNumber && { unitNumber: tx.unitNumber }),
      ...(CARD_TO_TRUCK[tx.cardNumber] && { truckId: CARD_TO_TRUCK[tx.cardNumber] }),
      ...(tx.driverName && { driverName: tx.driverName }),
      ...(tx.odometer != null && { odometer: tx.odometer }),
      ...(tx.locationName && { locationName: tx.locationName }),
      ...(tx.city && { city: tx.city }),
      ...(tx.state && { state: tx.state }),
      fees: tx.fees,
      fuelType: tx.fuelType,
      itemCategory: tx.itemCategory,
      pricePerUnit: tx.pricePerUnit,
      quantity: tx.quantity,
      amount: tx.amount,
      currency: 'USD',
      sourceFile: basename(filePath),
      importedAt: new Date().toISOString(),
    }
    const result = await callAppSync(CREATE_MUTATION, { input }, idToken)
    if (result.errors) {
      console.error(`  FAIL ${key}: ${result.errors[0].message}`)
      failed++
    } else {
      existing.add(key)
      inserted++
    }
  }

  console.log(`Done: ${inserted} inserted, ${duplicates} duplicates skipped, ${failed} failed.`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
