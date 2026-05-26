/**
 * EFS Transaction Report parser — shared by the fuel-import Lambda.
 *
 * Kept in sync with src/lib/parsers/efsTransactionReport.ts.
 * Return type is ParsedFuelTransaction[] (throws on validation error)
 * to match how the Lambda handler consumes it.
 */

export type ItemCategory = 'FUEL' | 'SCALE' | 'CASH_ADVANCE' | 'OTHER'

export interface ParsedFuelTransaction {
  cardNumber:       string
  transactionDate:  string
  invoiceNumber:    string
  unitNumber:       string
  driverName:       string
  odometer:         number | null
  locationName:     string
  city:             string
  state:            string
  fees:             number
  fuelType:         string
  itemCategory:     ItemCategory
  pricePerUnit:     number
  quantity:         number
  amount:           number
  currency:         string
  sourceLineNumber: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, ''))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Fuel definition: ULSD, FUEL (generic diesel code), DEF/DEFD, and bio-diesel blends.
// Confirmed permanent — all three (ULSD + FUEL + DEFD) count as fuel everywhere in the app.
const FUEL_ITEM_TYPES = new Set(['ULSD', 'FUEL', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])

function categorize(itemType: string): ItemCategory {
  const u = itemType.toUpperCase().trim()
  if (FUEL_ITEM_TYPES.has(u)) return 'FUEL'
  if (u === 'SCLE') return 'SCALE'
  if (u === 'CASH') return 'CASH_ADVANCE'
  if (u === 'CDSL') return 'OTHER'  // cardlock/discount diesel — excluded from fuel totals
  console.warn(`[EFS parser] Unknown item type: ${u} — stored as OTHER`)
  return 'OTHER'
}

// Transaction line: ends with a single letter (N/C debit indicator), 2–4 spaces, "USD/Gallon"
// The URL-download format uses 2 spaces; the DAILY FUEL REPORT TEXT format uses 3 spaces.
const TX_LINE_RE = /[A-Z]\s{2,4}USD\/Gallon\s*$/

// Right-side fields. Price is OPTIONAL for flat-rate items (e.g. SCLE scale fees).
//   Fuel:  itemType price  qty  amount  DB  USD/Gallon
//   Flat:  itemType        qty  amount  DB  USD/Gallon
const RIGHT_RE = /(\S+)\s+(?:([\d,]+\.?\d*)\s+)?([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([A-Z])\s+USD\/Gallon/

// Card number at the very start of the line (2–8 leading spaces, then 5 digits).
// URL-download format uses 6 spaces; DAILY FUEL REPORT TEXT format uses 2 spaces.
const CARD_RE = /^\s{2,8}(\d{5})\s/

// ISO date (YYYY-MM-DD) or US date (M/D/YYYY) anywhere in the line
const DATE_RE = /(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/

function normalizeDate(s: string): string {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return s
}

// Total Records in the report header line
const TOTAL_RECORDS_RE = /Total Records:\s*(\d+)/i

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseEfsReport(text: string): ParsedFuelTransaction[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const transactions: ParsedFuelTransaction[] = []

  let prevCard     = ''
  let prevDate     = ''
  let prevInvoice  = ''
  let prevUnit     = ''
  let prevDriver   = ''
  let prevOdo: number | null = null
  let prevLocation = ''
  let prevCity     = ''
  let prevState    = ''

  const grandTotals: Record<string, { amount: number; quantity: number }> = {}
  let grandFees = 0
  let inGrandTotals = false

  // Group-section accumulators — used when the report has no Grand Totals section
  // (e.g. the DAILY FUEL REPORT TEXT email format).
  const groupSumTotals: Record<string, { amount: number; quantity: number }> = {}
  let groupSumFees = 0
  let inGroupSection = false

  // Total Records stated in the report header (used for count validation)
  let totalRecords: number | null = null

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i]
    const lineNum = i + 1

    // Parse "Total Records: N" from header (only look once, before section flags)
    if (!inGrandTotals && !inGroupSection && totalRecords === null) {
      const trM = line.match(TOTAL_RECORDS_RE)
      if (trM) totalRecords = parseInt(trM[1], 10)
    }

    if (/Grand Totals/i.test(line)) { inGrandTotals = true; inGroupSection = false; continue }

    if (inGrandTotals) {
      // "  ULSD   3,757.82   681.01   5.435"  or  "  SCLE   19.75   2"
      const fuelM = line.match(/^\s+(\S+)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/)
      if (fuelM && !line.includes('Total Fuel')) {
        grandTotals[fuelM[1]] = { amount: parseNum(fuelM[2]), quantity: parseNum(fuelM[3]) }
      }
      const feesM = line.match(/^\s+Fees\s+([\d,]+\.?\d*)/)
      if (feesM) grandFees = parseNum(feesM[1])
      continue
    }

    // Detect start of a Group section (e.g. "  Group: 1  00031 ...")
    if (/^\s+Group:/i.test(line)) { inGroupSection = true; continue }

    if (inGroupSection) {
      if (!TX_LINE_RE.test(line)) {
        // Non-transaction line inside group section — accumulate subtotals
        const fuelM = line.match(/^\s+(\S+)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/)
        if (fuelM) {
          const type = fuelM[1]
          if (type !== 'Fees' && type !== 'Totals' && !line.includes('Total Fuel')) {
            if (!groupSumTotals[type]) groupSumTotals[type] = { amount: 0, quantity: 0 }
            groupSumTotals[type].amount   = round2(groupSumTotals[type].amount   + parseNum(fuelM[2]))
            groupSumTotals[type].quantity = round2(groupSumTotals[type].quantity + parseNum(fuelM[3]))
          }
        }
        const feesM = line.match(/^\s+Fees\s+([\d,]+\.?\d*)/)
        if (feesM) groupSumFees = round2(groupSumFees + parseNum(feesM[1]))
        continue
      }
      // TX_LINE_RE match inside group section: only exit group mode for a real
      // transaction (has card# + date). A match without both is a malformed
      // summary line — skip it rather than treating it as a continuation row.
      if (!line.match(CARD_RE) || !line.match(DATE_RE)) continue
      inGroupSection = false
    }

    if (!TX_LINE_RE.test(line)) continue
    const rightM = line.match(RIGHT_RE)
    if (!rightM) continue

    const fuelType     = rightM[1]
    const pricePerUnit = rightM[2] !== undefined ? parseNum(rightM[2]) : 0
    const quantity     = parseNum(rightM[3])
    const amount       = parseNum(rightM[4])
    const itemCategory = categorize(fuelType)

    const cardM = line.match(CARD_RE)
    const dateM = line.match(DATE_RE)

    let cardNumber: string, transactionDate: string, invoiceNumber: string
    let unitNumber: string, driverName: string, odometer: number | null
    let locationName: string, city: string, state: string
    let fees = 0

    if (cardM && dateM) {
      cardNumber      = cardM[1]
      const rawDate   = dateM[1]
      transactionDate = normalizeDate(rawDate)

      const dateEnd   = line.indexOf(rawDate) + rawDate.length
      const fuelStart = line.indexOf(rightM[0])
      const middle    = line.slice(dateEnd, fuelStart)
      const tokens    = middle.split(/\s{2,}/).map((t) => t.trim()).filter(Boolean)

      invoiceNumber = tokens[0] ?? ''
      unitNumber    = tokens[1] ?? ''

      let idx = 2
      if (tokens[idx] !== undefined && /^\d+$/.test(tokens[idx])) {
        // No driver name — next token is the odometer
        driverName = ''
        odometer   = parseInt(tokens[idx], 10)
        idx++
      } else {
        driverName = tokens[idx] ?? ''
        idx++
        odometer   = tokens[idx] ? parseInt(tokens[idx].replace(/,/g, ''), 10) : null
        idx++
      }

      locationName = tokens[idx] ?? ''; idx++
      city         = tokens[idx] ?? ''; idx++
      state        = tokens[idx] ?? ''; idx++

      if (tokens[idx] !== undefined && /^[\d,]+\.\d+$/.test(tokens[idx])) {
        fees = parseNum(tokens[idx])
      }

      prevCard = cardNumber; prevDate = transactionDate; prevInvoice = invoiceNumber
      prevUnit = unitNumber; prevDriver = driverName; prevOdo = odometer
      prevLocation = locationName; prevCity = city; prevState = state
    } else {
      // Continuation row — inherits header from the previous primary row
      cardNumber = prevCard; transactionDate = prevDate; invoiceNumber = prevInvoice
      unitNumber = prevUnit; driverName = prevDriver; odometer = prevOdo
      locationName = prevLocation; city = prevCity; state = prevState
      fees = 0
    }

    transactions.push({
      cardNumber, transactionDate, invoiceNumber, unitNumber, driverName, odometer,
      locationName, city, state, fees,
      fuelType, itemCategory, pricePerUnit, quantity, amount,
      currency: 'USD', sourceLineNumber: lineNum,
    })
  }

  // ── Grand-total validation ────────────────────────────────────────────────
  // If the report had no Grand Totals section (e.g. DAILY FUEL REPORT TEXT format),
  // fall back to the accumulated per-group subtotals for validation.
  const validationTotals = Object.keys(grandTotals).length > 0 ? grandTotals : groupSumTotals
  const validationFees   = grandFees > 0 ? grandFees : groupSumFees

  const summedByType: Record<string, { amount: number; quantity: number }> = {}
  let summedFees = 0

  for (const tx of transactions) {
    if (!summedByType[tx.fuelType]) summedByType[tx.fuelType] = { amount: 0, quantity: 0 }
    summedByType[tx.fuelType].amount   = round2(summedByType[tx.fuelType].amount + tx.amount)
    summedByType[tx.fuelType].quantity = round2(summedByType[tx.fuelType].quantity + tx.quantity)
    summedFees = round2(summedFees + tx.fees)
  }

  const errors: string[] = []

  // Count validation (from "Total Records: N" header)
  if (totalRecords !== null && transactions.length !== totalRecords) {
    errors.push(`Transaction count mismatch: parsed ${transactions.length}, header says ${totalRecords}`)
  }

  for (const [type, reported] of Object.entries(validationTotals)) {
    const parsed    = summedByType[type]
    const parsedAmt = parsed?.amount ?? 0
    const amtDiff   = Math.abs(parsedAmt - reported.amount)
    if (amtDiff > 0.02) {
      errors.push(`${type} amount mismatch: parsed $${parsedAmt.toFixed(2)} vs reported $${reported.amount.toFixed(2)}`)
    }
    if (FUEL_ITEM_TYPES.has(type.toUpperCase())) {
      const parsedQty = parsed?.quantity ?? 0
      const qtyDiff   = Math.abs(parsedQty - reported.quantity)
      if (qtyDiff > 0.02) {
        errors.push(`${type} quantity mismatch: parsed ${parsedQty.toFixed(3)} vs reported ${reported.quantity.toFixed(3)}`)
      }
    }
  }
  if (validationFees > 0 && Math.abs(summedFees - validationFees) > 0.02) {
    errors.push(`Fees mismatch: parsed $${summedFees.toFixed(2)} vs reported $${validationFees.toFixed(2)}`)
  }

  if (errors.length > 0) throw new Error(`EFS parse validation failed:\n${errors.join('\n')}`)

  return transactions
}

export function dedupKey(tx: Pick<ParsedFuelTransaction, 'transactionDate' | 'cardNumber' | 'invoiceNumber' | 'fuelType'>): string {
  return `${tx.transactionDate}|${tx.cardNumber}|${tx.invoiceNumber}|${tx.fuelType}`
}
