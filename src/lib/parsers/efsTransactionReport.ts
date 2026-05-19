/**
 * Parser for EFS Transaction Reports (fixed-width text format).
 *
 * Transaction lines are identified by the "USD/Gallon" suffix.
 * Continuation lines (blank Card # area) inherit the prior row's header fields
 * so that multi-product stops (e.g. DEFD + ULSD on same invoice) are captured.
 */

export interface ParsedFuelTransaction {
  cardNumber:     string        // as it appears in the report, e.g. "00056"
  transactionDate: string       // YYYY-MM-DD
  invoiceNumber:  string
  unitNumber:     string        // raw from Unit column (may be "0530", "009", blank)
  driverName:     string
  odometer:       number | null
  locationName:   string
  city:           string
  state:          string
  fees:           number        // dollars on this line item (0 if blank)
  fuelType:       string        // "ULSD" | "DEFD" | other
  pricePerUnit:   number
  quantity:       number
  amount:         number
  currency:       string
  sourceLineNumber: number
}

export interface ParsedTotals {
  byFuelType: Record<string, { amount: number; quantity: number }>
  fees:       number
  totalFuel:  number
  totalAmount: number
}

export interface ParsedReport {
  transactions: ParsedFuelTransaction[]
  grandTotals:  ParsedTotals
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, ''))
}

// Detect a transaction data line: ends with "N  USD/Gallon" or "C  USD/Gallon"
const TX_LINE_RE = /[A-Z]\s{2}USD\/Gallon\s*$/

// Extract the right-side fields: fuelType price qty amt DB currency
const RIGHT_RE = /(ULSD|DEFD|\S+)\s+([\d.]+)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([A-Z])\s+USD\/Gallon/

// Match a card number at the start of the line (5 digits, after 4-8 leading spaces)
const CARD_RE = /^\s{4,8}(\d{5})\s/

// Match a date in YYYY-MM-DD format anywhere in a line
const DATE_RE = /(\d{4}-\d{2}-\d{2})/

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseEfsTransactionReport(text: string): ParsedReport {
  const lines = text.split('\n')
  const transactions: ParsedFuelTransaction[] = []

  // Context inherited by continuation rows
  let prevCard     = ''
  let prevDate     = ''
  let prevInvoice  = ''
  let prevUnit     = ''
  let prevDriver   = ''
  let prevOdo: number | null = null
  let prevLocation = ''
  let prevCity     = ''
  let prevState    = ''

  // Grand totals parsed from the report footer
  const grandTotals: ParsedTotals = {
    byFuelType: {},
    fees: 0,
    totalFuel: 0,
    totalAmount: 0,
  }
  let inGrandTotals = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // ── Grand totals section ──────────────────────────────────────────────────
    if (/Grand Totals/i.test(line)) {
      inGrandTotals = true
      continue
    }

    if (inGrandTotals) {
      // "ULSD   3,757.82   681.01   5.435" or "DEFD   30.44   6.09   4.999"
      const fuelM = line.match(/^\s+(ULSD|DEFD|\S+)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/)
      if (fuelM && !line.includes('Total Fuel')) {
        grandTotals.byFuelType[fuelM[1]] = {
          amount:   parseNum(fuelM[2]),
          quantity: parseNum(fuelM[3]),
        }
      }
      // "Fees   4.00"
      const feesM = line.match(/^\s+Fees\s+([\d,]+\.?\d*)/)
      if (feesM) grandTotals.fees = parseNum(feesM[1])

      // "Totals   3,792.26"
      const totalsM = line.match(/^\s+Totals\s+([\d,]+\.?\d*)/)
      if (totalsM && !line.includes('Total Fuel')) grandTotals.totalAmount = parseNum(totalsM[1])

      // "Total Fuel   3,757.82   681.01"
      const tfM = line.match(/^\s+Total Fuel\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/)
      if (tfM) grandTotals.totalFuel = parseNum(tfM[1])

      continue
    }

    // ── Transaction lines ─────────────────────────────────────────────────────
    if (!TX_LINE_RE.test(line)) continue

    // Extract right-side fields
    const rightM = line.match(RIGHT_RE)
    if (!rightM) continue
    const fuelType    = rightM[1]
    const pricePerUnit = parseFloat(rightM[2])
    const quantity    = parseNum(rightM[3])
    const amount      = parseNum(rightM[4])
    const currency    = 'USD'

    // Determine if this is a primary row (has card + date) or continuation
    const cardM = line.match(CARD_RE)
    const dateM = line.match(DATE_RE)

    let cardNumber:     string
    let transactionDate: string
    let invoiceNumber:  string
    let unitNumber:     string
    let driverName:     string
    let odometer:       number | null
    let locationName:   string
    let city:           string
    let state:          string
    let fees = 0

    if (cardM && dateM) {
      // ── Primary row ─────────────────────────────────────────────────────────
      cardNumber     = cardM[1]
      transactionDate = dateM[1]

      // Extract the slice between the date and the fuelType match
      const dateEnd   = line.indexOf(transactionDate) + transactionDate.length
      const fuelStart = line.indexOf(rightM[0])
      const middle    = line.slice(dateEnd, fuelStart)

      // Split by 2+ spaces to get individual fields
      const tokens = middle.split(/\s{2,}/).map((t) => t.trim()).filter(Boolean)

      // Layout: invoice, unit, [driver?], odometer, location, city, state[, fee?]
      // If token[2] is pure digits → driver was blank
      invoiceNumber = tokens[0] ?? ''
      unitNumber    = tokens[1] ?? ''

      let idx = 2
      if (tokens[idx] !== undefined && /^\d+$/.test(tokens[idx])) {
        driverName = ''
        odometer   = parseInt(tokens[idx], 10)
        idx++
      } else {
        driverName = tokens[idx] ?? ''
        idx++
        odometer   = tokens[idx] ? parseInt(tokens[idx].replace(/,/g, ''), 10) : null
        idx++
      }

      locationName = tokens[idx] ?? ''
      idx++
      city  = tokens[idx] ?? ''
      idx++
      state = tokens[idx] ?? ''
      idx++

      // Optional fee
      if (tokens[idx] !== undefined && /^[\d,]+\.\d+$/.test(tokens[idx])) {
        fees = parseNum(tokens[idx])
      }

      // Save for potential continuation rows
      prevCard     = cardNumber
      prevDate     = transactionDate
      prevInvoice  = invoiceNumber
      prevUnit     = unitNumber
      prevDriver   = driverName
      prevOdo      = odometer
      prevLocation = locationName
      prevCity     = city
      prevState    = state
    } else {
      // ── Continuation row (blank card # area) ─────────────────────────────────
      // Inherits all header fields from the previous primary row
      cardNumber      = prevCard
      transactionDate = prevDate
      invoiceNumber   = prevInvoice
      unitNumber      = prevUnit
      driverName      = prevDriver
      odometer        = prevOdo
      locationName    = prevLocation
      city            = prevCity
      state           = prevState
      fees            = 0  // fees are on the primary row only
    }

    transactions.push({
      cardNumber,
      transactionDate,
      invoiceNumber,
      unitNumber,
      driverName,
      odometer,
      locationName,
      city,
      state,
      fees,
      fuelType,
      pricePerUnit,
      quantity,
      amount,
      currency,
      sourceLineNumber: lineNum,
    })
  }

  // ── Grand total assertion ─────────────────────────────────────────────────
  const summedByFuel: Record<string, { amount: number; quantity: number }> = {}
  let summedFees = 0

  for (const tx of transactions) {
    if (!summedByFuel[tx.fuelType]) summedByFuel[tx.fuelType] = { amount: 0, quantity: 0 }
    summedByFuel[tx.fuelType].amount   = round2(summedByFuel[tx.fuelType].amount + tx.amount)
    summedByFuel[tx.fuelType].quantity = round2(summedByFuel[tx.fuelType].quantity + tx.quantity)
    summedFees = round2(summedFees + tx.fees)
  }

  const errors: string[] = []
  for (const [fuel, reported] of Object.entries(grandTotals.byFuelType)) {
    const parsed = summedByFuel[fuel]
    if (!parsed) {
      errors.push(`${fuel}: found in grand totals but no transactions parsed`)
      continue
    }
    const amtDiff = Math.abs(parsed.amount - reported.amount)
    const qtyDiff = Math.abs(parsed.quantity - reported.quantity)
    if (amtDiff > 0.02) {
      errors.push(`${fuel} amount mismatch: parsed $${parsed.amount.toFixed(2)}, reported $${reported.amount.toFixed(2)} (diff $${amtDiff.toFixed(2)})`)
    }
    if (qtyDiff > 0.02) {
      errors.push(`${fuel} quantity mismatch: parsed ${parsed.quantity.toFixed(3)} gal, reported ${reported.quantity.toFixed(3)} gal (diff ${qtyDiff.toFixed(3)})`)
    }
  }
  const feesDiff = Math.abs(summedFees - grandTotals.fees)
  if (grandTotals.fees > 0 && feesDiff > 0.02) {
    errors.push(`Fees mismatch: parsed $${summedFees.toFixed(2)}, reported $${grandTotals.fees.toFixed(2)}`)
  }

  if (errors.length > 0) {
    throw new Error(`EFS report validation failed:\n${errors.join('\n')}`)
  }

  return { transactions, grandTotals }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Natural dedup key for a transaction */
export function fuelTxDedupKey(tx: Pick<ParsedFuelTransaction, 'transactionDate' | 'cardNumber' | 'invoiceNumber' | 'fuelType'>): string {
  return `${tx.transactionDate}|${tx.cardNumber}|${tx.invoiceNumber}|${tx.fuelType}`
}
