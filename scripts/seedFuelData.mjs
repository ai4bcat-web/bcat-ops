#!/usr/bin/env node
/**
 * Seed fuel transactions from tests/fixtures/fuel-sample.txt into Amplify/AppSync.
 * Usage:
 *   BCAT_EMAIL=you@example.com BCAT_PASSWORD=YourPass node scripts/seedFuelData.mjs
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Config from amplify_outputs.json ─────────────────────────────────────────
const outputs = JSON.parse(
  readFileSync(resolve(__dirname, '../amplify_outputs.json'), 'utf8'),
)
const APPSYNC_URL = outputs.data.url

Amplify.configure(outputs)

// ─── Truck card mapping (matches useAppStore seed) ────────────────────────────
const CARD_TO_TRUCK = {
  '00049': 'eq-mnmpi9jxwd12',  // Unit 009
  '00056': 'eq-mnevxuyoxpd8',  // Unit 299
  '00031': 'eq-mnevuhxgs5jf',  // Unit 530
  '00007': 'eq-mnevvq8q6tcx',  // Unit 685
  '00023': 'eq-mnevwst30vwt',  // Unit 780
}

// ─── Minimal EFS parser ───────────────────────────────────────────────────────

function parseReport(text) {
  const lines = text.split('\n')
  const transactions = []

  const FUEL_LINE = /USD\/Gallon/
  const CARD_RE   = /^\s{0,10}(\d{5})\s/
  const DATE_RE   = /\b(\d{4}-\d{2}-\d{2})\b/
  const RIGHT_RE  = /(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+USD\/Gallon\s*(\S+)?\s*$/

  let prevCard = '', prevDate = '', prevInvoice = '', prevUnit = '', prevDriver = ''
  let prevLocation = '', prevCity = '', prevState = ''

  for (const line of lines) {
    if (!FUEL_LINE.test(line)) continue
    const rightMatch = RIGHT_RE.exec(line)
    if (!rightMatch) continue

    const [, rawQty, rawPpu, rawFees, rawTotal] = rightMatch
    const quantity     = parseFloat(rawQty.replace(/,/g, ''))
    const pricePerUnit = parseFloat(rawPpu.replace(/,/g, ''))
    const fees         = rawFees === '0.00' ? 0 : parseFloat((rawFees ?? '0').replace(/,/g, ''))
    const amount       = parseFloat(rawTotal.replace(/,/g, ''))

    const fuelTypeMatch = /(\w+)\s+USD\/Gallon/.exec(line)
    const fuelType = fuelTypeMatch ? fuelTypeMatch[1] : 'ULSD'

    const cardMatch = CARD_RE.exec(line)
    const dateMatch = DATE_RE.exec(line)
    const isPrimary = !!cardMatch && !!dateMatch

    let cardNumber, transactionDate, invoiceNumber, unitNumber, driverName
    let locationName, city, state, odometer

    if (isPrimary) {
      cardNumber      = cardMatch[1]
      transactionDate = dateMatch[1]

      const leftPart = line.substring(0, line.indexOf('USD/Gallon')).trimEnd()
      const tokens   = leftPart.split(/\s{2,}/).map(s => s.trim()).filter(Boolean)

      invoiceNumber = tokens[2] ?? ''
      unitNumber    = tokens[3] ?? ''

      let idx = 4
      if (tokens[idx] && /^\d+$/.test(tokens[idx])) {
        odometer   = parseInt(tokens[idx], 10)
        driverName = ''
        idx++
      } else {
        driverName = tokens[idx] ?? ''
        idx++
        odometer   = (tokens[idx] && /^\d+$/.test(tokens[idx])) ? parseInt(tokens[idx], 10) : null
        if (odometer !== null) idx++
      }

      locationName = tokens[idx]     ?? ''
      city         = tokens[idx + 1] ?? ''
      state        = tokens[idx + 2] ?? ''

      prevCard = cardNumber; prevDate = transactionDate; prevInvoice = invoiceNumber
      prevUnit = unitNumber; prevDriver = driverName
      prevLocation = locationName; prevCity = city; prevState = state
    } else {
      cardNumber = prevCard; transactionDate = prevDate; invoiceNumber = prevInvoice
      unitNumber = prevUnit; driverName = prevDriver
      locationName = prevLocation; city = prevCity; state = prevState
      odometer = null
    }

    transactions.push({
      cardNumber, transactionDate, invoiceNumber, unitNumber, driverName,
      locationName, city, state, odometer, fuelType,
      quantity, pricePerUnit, fees, amount,
    })
  }

  return transactions
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const CREATE_MUTATION = `
  mutation CreateFuelTransaction($input: CreateFuelTransactionInput!) {
    createFuelTransaction(input: $input) { id transactionDate cardNumber fuelType amount }
  }
`

async function callAppSync(query, variables, idToken) {
  const res = await fetch(APPSYNC_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': idToken },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const email    = process.env.BCAT_EMAIL
  const password = process.env.BCAT_PASSWORD

  if (!email || !password) {
    console.error('Usage: BCAT_EMAIL=... BCAT_PASSWORD=... node scripts/seedFuelData.mjs')
    process.exit(1)
  }

  console.log(`Authenticating as ${email}…`)
  await signIn({ username: email, password })
  const session = await fetchAuthSession()
  const idToken = session.tokens?.idToken?.toString()
  if (!idToken) { console.error('No ID token after sign-in'); process.exit(1) }
  console.log('Authenticated.\n')

  const fixturePath = resolve(__dirname, '../tests/fixtures/fuel-sample.txt')
  const transactions = parseReport(readFileSync(fixturePath, 'utf8'))
  console.log(`Parsed ${transactions.length} transactions from fuel-sample.txt\n`)

  let inserted = 0, skipped = 0
  for (const tx of transactions) {
    const input = {
      transactionDate: tx.transactionDate,
      cardNumber:      tx.cardNumber,
      ...(tx.invoiceNumber && { invoiceNumber: tx.invoiceNumber }),
      ...(tx.unitNumber    && { unitNumber:    tx.unitNumber }),
      ...(CARD_TO_TRUCK[tx.cardNumber] && { truckId: CARD_TO_TRUCK[tx.cardNumber] }),
      ...(tx.driverName    && { driverName:    tx.driverName }),
      ...(tx.odometer != null && { odometer:  tx.odometer }),
      ...(tx.locationName  && { locationName: tx.locationName }),
      ...(tx.city          && { city:         tx.city }),
      ...(tx.state         && { state:        tx.state }),
      fees:         tx.fees,
      fuelType:     tx.fuelType,
      pricePerUnit: tx.pricePerUnit,
      quantity:     tx.quantity,
      amount:       tx.amount,
      currency:     'USD',
      sourceFile:   'fuel-sample.txt',
      importedAt:   new Date().toISOString(),
    }

    const result = await callAppSync(CREATE_MUTATION, { input }, idToken)
    if (result.errors) {
      console.error(`  SKIP  ${tx.transactionDate} card=${tx.cardNumber} inv=${tx.invoiceNumber} ${tx.fuelType}: ${result.errors[0].message}`)
      skipped++
    } else {
      const r = result.data.createFuelTransaction
      console.log(`  OK    ${r.transactionDate}  card=${r.cardNumber}  ${r.fuelType}  $${r.amount}  id=${r.id}`)
      inserted++
    }
  }

  console.log(`\nDone: ${inserted} inserted, ${skipped} skipped.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
